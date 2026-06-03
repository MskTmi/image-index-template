const fs = require('node:fs/promises');
const path = require('node:path');
const { compareText, loadCharacterIndex } = require('./character-index.js');

// 扫描 meta 目录，生成可供前端或脚本直接消费的聚合索引文件。
// 保持索引结构稳定，是这个模板仓库最重要的发布步骤之一。

const META_DIR = path.resolve(__dirname, '../meta');
const IMAGE_DIST_FILE = path.resolve(__dirname, '../dist/image-index.json');
const CHARACTER_DIST_FILE = path.resolve(__dirname, '../dist/character-index.json');
const ALIAS_MAP_DIST_FILE = path.resolve(__dirname, '../dist/alias-map.json');

function isJsonFile(name) {
    return name.toLowerCase().endsWith('.json');
}

function ensureString(value, fieldName, fileName) {
    // 构建阶段直接失败，避免坏 metadata 混入最终索引。
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${fileName}: ${fieldName} must be a non-empty string.`);
    }

    return value.trim();
}

function ensureStringList(value, fieldName, fileName) {
    // 统一去重并排序，保证索引输出可预测，减少无意义 diff。
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${fileName}: ${fieldName} must be a non-empty array.`);
    }

    const list = value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);

    if (list.length === 0) {
        throw new Error(`${fileName}: ${fieldName} must contain at least one non-empty string.`);
    }

    return Array.from(new Set(list)).sort(compareText);
}

async function readMetaFiles() {
    // 逐个读取 metadata，并在这里完成结构校验与规范化。
    let entries = [];

    try {
        entries = await fs.readdir(META_DIR, { withFileTypes: true });
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }

    const files = entries
        .filter((entry) => entry.isFile() && isJsonFile(entry.name))
        .map((entry) => entry.name)
        .sort(compareText);

    const items = [];

    for (const fileName of files) {
        const filePath = path.join(META_DIR, fileName);
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const id = ensureString(raw.id, 'id', fileName);
        const image = ensureString(raw.image, 'image', fileName);
        const hash = typeof raw.hash === 'string' ? raw.hash.trim() : '';
        const width = typeof raw.width === 'number' ? raw.width : 0;
        const height = typeof raw.height === 'number' ? raw.height : 0;
        const games = ensureStringList(raw.games, 'games', fileName);
        const characters = ensureStringList(raw.characters, 'characters', fileName);
        const lastUpdated = typeof raw.last_updated === 'string' && raw.last_updated.trim()
            ? raw.last_updated.trim()
            : new Date().toISOString();

        items.push({ id, image, hash, width, height, games, characters, last_updated: lastUpdated });
    }

    return items.sort((left, right) => compareText(left.id, right.id));
}

async function buildIndex() {
    // 将单图 metadata 重组成总表和倒排索引，便于按游戏与角色检索。
    const generatedAt = new Date().toISOString();
    const items = await readMetaFiles();
    const characterIndex = await loadCharacterIndex();

    const imageIndex = {
        schema_version: 1,
        generated_at: generatedAt,
        assets: {},
        games: {},
        characters: {}
    };
    const knownCharacterIds = new Set(Object.keys(characterIndex.characters));

    for (const item of items) {
        for (const character of item.characters) {
            if (knownCharacterIds.size > 0 && !knownCharacterIds.has(character)) {
                throw new Error(`meta/${item.id}.json: characters must use canonical ids only. Unknown character id \"${character}\".`);
            }
        }

        imageIndex.assets[item.id] = {
            image: item.image,
            hash: item.hash,
            width: item.width,
            height: item.height,
            games: item.games,
            characters: item.characters,
            last_updated: item.last_updated
        };

        // 一张图可能归属多个游戏，倒排索引中分别录入。
        for (const g of item.games) {
            if (!imageIndex.games[g]) {
                imageIndex.games[g] = [];
            }

            imageIndex.games[g].push(item.id);
        }

        for (const character of item.characters) {
            if (!imageIndex.characters[character]) {
                imageIndex.characters[character] = [];
            }

            imageIndex.characters[character].push(item.id);
        }
    }

    const aliasMap = Object.fromEntries(
        Array.from(characterIndex.aliasMap.entries()).sort(([left], [right]) => compareText(left, right))
    );

    await fs.mkdir(path.dirname(IMAGE_DIST_FILE), { recursive: true });
    await fs.writeFile(IMAGE_DIST_FILE, `${JSON.stringify(imageIndex, null, 2)}\n`, 'utf8');
    await fs.writeFile(CHARACTER_DIST_FILE, `${JSON.stringify(characterIndex.characters, null, 2)}\n`, 'utf8');
    await fs.writeFile(ALIAS_MAP_DIST_FILE, `${JSON.stringify(aliasMap, null, 2)}\n`, 'utf8');

    return {
        imageIndex,
        characterIndex: characterIndex.characters,
        aliasMap
    };
}

if (require.main === module) {
    buildIndex().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    buildIndex
};