import { loadConfig } from "../config.js";
import { openDatabase } from "../db/database.js";

const config = loadConfig();
const db = await openDatabase(config);

const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get() as {
  count: number;
};

process.stdout.write(`Database initialized at ${config.databasePath}\n`);
process.stdout.write(`Users: ${userCount.count}\n`);

if (userCount.count === 0) {
  process.stdout.write("No users exist yet. Set MUSICDECK_ADMIN_PASSWORD and rerun db:init to create the first admin.\n");
}

db.close();
