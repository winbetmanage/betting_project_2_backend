import fs from 'fs';
import path from 'path';
import ApiError from '../utils/ApiError';
import { getAllSportsUrl } from '../../codes';

type StaticGame = {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
};

let cache: StaticGame[] | null = null;

function load(): StaticGame[] {
  if (cache) return cache;
  const filePath = path.join(__dirname, '..', '..', 'json_store', 'static_data', 'all_games_list.json');
  // fallback for compiled dist: __dirname is dist/src/services, so go up 3 levels to project root
  const altPath = path.join(__dirname, '..', '..', '..', 'json_store', 'static_data', 'all_games_list.json');
  const target = fs.existsSync(filePath) ? filePath : altPath;
  if (!fs.existsSync(target)) throw new ApiError(500, 'Static games file not found');
  const raw = fs.readFileSync(target, 'utf-8');
  cache = JSON.parse(raw) as StaticGame[];
  return cache;
}

export const listStaticGames = (filters: Record<string, unknown> = {}) => {
  const all = load();
  let filtered = all;

  const search = typeof filters.search === 'string' ? filters.search.trim().toLowerCase() : '';
  if (search) {
    filtered = filtered.filter(
      (g) =>
        g.key.toLowerCase().includes(search) ||
        g.group.toLowerCase().includes(search) ||
        g.title.toLowerCase().includes(search) ||
        g.description.toLowerCase().includes(search)
    );
  }

  if (filters.group && typeof filters.group === 'string') {
    filtered = filtered.filter((g) => g.group === filters.group);
  }
  if (filters.active !== undefined) {
    const active = filters.active === 'true' || filters.active === true;
    filtered = filtered.filter((g) => g.active === active);
  }
  if (filters.has_outrights !== undefined) {
    const v = filters.has_outrights === 'true' || filters.has_outrights === true;
    filtered = filtered.filter((g) => g.has_outrights === v);
  }

  const page = Math.max(1, parseInt(String(filters.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(filters.limit ?? '10'), 10) || 10));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * limit;
  const data = filtered.slice(start, start + limit);

  const groups = [...new Set(all.map((g) => g.group))].sort();

  return {
    data,
    total,
    page: currentPage,
    limit,
    totalPages,
    groups,
  };
};

export const getStaticGameByKey = (key: string) => {
  const all = load();
  const found = all.find((g) => g.key === key);
  if (!found) throw new ApiError(404, 'Game not found');
  return found;
};

function getStoreDir(): string {
  const dir1 = path.join(__dirname, '..', '..', 'json_store', 'static_data');
  const dir2 = path.join(__dirname, '..', '..', '..', 'json_store', 'static_data');
  if (fs.existsSync(dir1)) return dir1;
  if (fs.existsSync(dir2)) return dir2;
  // fallback to project root detection
  const cwdDir = path.join(process.cwd(), 'json_store', 'static_data');
  if (fs.existsSync(cwdDir)) return cwdDir;
  // create if not exists
  fs.mkdirSync(dir1, { recursive: true });
  return dir1;
}

export const refetchAndSave = async () => {
  const url = getAllSportsUrl();
  if (!url.includes('apiKey=') || url.includes('apiKey=undefined')) {
    throw new ApiError(500, 'API key not configured (API_ONE)');
  }
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `Failed to fetch sports: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new ApiError(500, 'Invalid data from sports API');

  const dir = getStoreDir();
  const basePath = path.join(dir, 'all_games_list.json');

  // Versioning: find existing versioned files
  // pattern all_games_list.json, all_games_list_2.json, ..._N.json
  if (fs.existsSync(basePath)) {
    const files = fs.readdirSync(dir);
    const versioned = files
      .filter((f) => /^all_games_list(?:_(\d+))?\.json$/.test(f))
      .map((f) => {
        const m = f.match(/^all_games_list(?:_(\d+))?\.json$/);
        if (!m) return 0;
        if (!m[1]) return 1; // all_games_list.json counts as 1
        return parseInt(m[1], 10);
      });
    const max = versioned.length ? Math.max(...versioned) : 1;
    const next = max + 1;
    // also handle case where only all_games_list.json exists (max=1 => next=2)
    // if all_games_list.json and all_games_list_2.json exist, max=2 => next=3, etc.
    const dest = path.join(dir, `all_games_list_${next}.json`);
    // rename current to versioned
    fs.renameSync(basePath, dest);
  }

  // write new data as all_games_list.json
  fs.writeFileSync(basePath, JSON.stringify(data, null, 4), 'utf-8');
  // clear cache so next load reads new file
  cache = null;
  // also try to ensure dist copy is updated if needed (for dev with dist)
  try {
    const distDir = path.join(__dirname, '..', '..', '..', 'json_store', 'static_data');
    if (fs.existsSync(distDir) && distDir !== dir) {
      const distPath = path.join(distDir, 'all_games_list.json');
      fs.writeFileSync(distPath, JSON.stringify(data, null, 4), 'utf-8');
    }
  } catch {}

  return {
    count: data.length,
    savedTo: basePath,
    totalFiles: fs.readdirSync(dir).filter((f) => f.startsWith('all_games_list')).length,
  };
};
