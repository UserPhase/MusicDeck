import { loadConfig } from "../config.js";
import { openDatabase } from "../db/database.js";

const config = loadConfig();
const db = await openDatabase(config);

const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get() as {
  count: number;
};

console.log(`Database initialized at ${config.databasePath}`);
console.log(`Users: ${userCount.count}`);

if (userCount.count === 0) {
  console.log("No users exist yet. Set MUSICDECK_ADMIN_PASSWORD and rerun db:init to create the first admin.");
}

db.close();
