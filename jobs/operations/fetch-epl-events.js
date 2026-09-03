import fs from 'fs';
import path from 'path';
import { FetchEplEvents } from '../../codes.js';

export async function runFetchEplEventsJob() {
  const timestamp = new Date().toISOString();
  try {
    const url = FetchEplEvents;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Fetch failed ${res.status} ${text.slice(0, 200)}`);
    }
    const events = await res.json();
    if (!Array.isArray(events)) throw new Error('Invalid response: expected array');

    const fetchedCount = events.length;

    try {
      const storePath = path.join(process.cwd(), 'json_store', 'static_data', 'epl_events.json');
      const altPath = path.join(process.cwd(), 'Back-end', 'json_store', 'static_data', 'epl_events.json');
      const targetPath = fs.existsSync(path.dirname(storePath)) ? storePath : altPath;
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(events, null, 2), 'utf-8');
      try {
        const distPath = path.join(process.cwd(), 'dist', 'json_store', 'static_data', 'epl_events.json');
        if (fs.existsSync(path.dirname(path.dirname(distPath))) || fs.existsSync(path.join(process.cwd(), 'dist'))) {
          fs.mkdirSync(path.dirname(distPath), { recursive: true });
          fs.writeFileSync(distPath, JSON.stringify(events, null, 2), 'utf-8');
        }
      } catch {}
    } catch (e) {
      console.warn(`[fetch-epl-events] ${timestamp} - warning: failed to write JSON snapshot`, e instanceof Error ? e.message : String(e));
    }

    console.log(`[fetch-epl-events] ${timestamp} - fetched ${fetchedCount} events, updated 0 games, 0 status transitions (json only)`);
    return { fetchedCount, updatedCount: 0, transitionCount: 0 };
  } catch (err) {
    console.error(`[fetch-epl-events] ${timestamp} - failed:`, err instanceof Error ? err.message : String(err));
    return { fetchedCount: 0, updatedCount: 0, transitionCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export default runFetchEplEventsJob;
