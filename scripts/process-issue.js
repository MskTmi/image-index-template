const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { customAlphabet } = require('nanoid');
const { CHARACTER_DIR, loadAliasMap, loadCharacterIndex, resolveCharacters } = require('./character-index.js');
const { parseIssueBody } = require('./issue-parser.js');
const { optimizeImage } = require('./optimize-image.js');

// 将单个 GitHub Issue 转换为仓库内的图片与 metadata 文件。
// 这个脚本是 Issue 自动导入流程的核心入口，适合作为模板复用。

const DATA_DIR = path.resolve(__dirname, '../data');
const META_DIR = path.resolve(__dirname, '../meta');
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_SIZE = 8;
const generateId = customAlphabet(ID_ALPHABET, ID_SIZE);

function parseArgs(argv) {
    // 复用在多个脚本中的轻量参数解析，只处理 --key value 形式。
    const args = {};

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];

        if (!token.startsWith('--')) {
            continue;
        }

        args[token.slice(2)] = argv[index + 1];
        index += 1;
    }

    return args;
}

async function fileExists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

async function createId() {
    // 同时检查 data 与 meta，避免只写入一半时出现 ID 冲突。
    while (true) {
        const id = generateId();
        const imagePath = path.join(DATA_DIR, `${id}.jpg`);
        const metaPath = path.join(META_DIR, `${id}.json`);

        if (!(await fileExists(imagePath)) && !(await fileExists(metaPath))) {
            return id;
        }
    }
}

async function downloadImage(url, tempDir, fileName) {
    // 先下载到临时目录，再交给 sharp 做统一编码，避免脏文件留在仓库目录。
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
        throw new Error(`URL is not an image: ${url}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const tempPath = path.join(tempDir, fileName);
    await fs.writeFile(tempPath, buffer);
    return tempPath;
}

async function writeMetadata({ id, games, characters }) {
    // metadata 只保存索引所需字段，保持单图数据结构稳定。
    const metadata = {
        id,
        image: `data/${id}.jpg`,
        games,
        characters
    };

    const metaFile = path.join(META_DIR, `${id}.json`);
    await fs.writeFile(metaFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    return metadata;
}

async function processIssue(issue) {
    // 弱自动化流程：已知角色解析为 canonical id 后直接导入；
    // 未知名称自动创建角色占位文件，一并进入 PR 等待人工审核。
    const parsed = parseIssueBody(issue.body || '');
    const aliasMap = await loadAliasMap();
    const characterIndex = await loadCharacterIndex();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-index-'));
    const { characters: resolvedCharacters, unresolved } = resolveCharacters(parsed.characters, {
        exists: aliasMap.size > 0,
        aliasMap
    });

    // 对未能匹配到已知角色的名称，自动创建 characters/{name}.json 占位文件。
    const newCharacterIds = [];
    const now = new Date().toISOString();

    for (const name of unresolved) {
        const charFilePath = path.join(CHARACTER_DIR, `${name}.json`);

        if (!(await fileExists(charFilePath))) {
            await fs.mkdir(CHARACTER_DIR, { recursive: true });

            const charEntry = {
                id: name,
                display_name: name,
                games: parsed.games,
                aliases: [],
                last_updated: now
            };

            await fs.writeFile(charFilePath, `${JSON.stringify(charEntry, null, 2)}\n`, 'utf8');
        }

        newCharacterIds.push(name);
    }

    const canonicalCharacters = [...resolvedCharacters, ...newCharacterIds];

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(META_DIR, { recursive: true });

    const created = [];

    try {
        for (let index = 0; index < parsed.imageUrls.length; index += 1) {
            const id = await createId();
            const tempSource = await downloadImage(parsed.imageUrls[index], tempDir, `${id}-source`);
            const finalImage = path.join(DATA_DIR, `${id}.jpg`);

            // 所有输入格式最终都统一输出为 JPEG，便于仓库存储和后续分发。
            await optimizeImage({ inputPath: tempSource, outputPath: finalImage });
            await writeMetadata({
                id,
                games: parsed.games,
                characters: canonicalCharacters
            });

            created.push(id);
        }
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }

    return {
        issue_number: issue.number,
        games: parsed.games,
        characters: canonicalCharacters,
        created,
        resolved_characters: resolvedCharacters,
        new_characters: newCharacterIds
    };
}

async function main() {
    // CLI 模式用于 GitHub Actions，也方便本地手工调试单个 Issue。
    const args = parseArgs(process.argv.slice(2));

    if (!args.issue) {
        throw new Error('Usage: node scripts/process-issue.js --issue <issue.json> [--output <result.json>]');
    }

    const issue = JSON.parse(await fs.readFile(path.resolve(process.cwd(), args.issue), 'utf8'));
    const result = await processIssue(issue);

    if (args.output) {
        await fs.writeFile(path.resolve(process.cwd(), args.output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } else {
        console.log(JSON.stringify(result, null, 2));
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    processIssue
};