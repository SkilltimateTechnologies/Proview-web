import { db } from "../src/api/database/index";
import { students, settings, classes } from "../src/api/database/schema";
import { eq } from "drizzle-orm";

const st = await db.select().from(students);
const enabled = st.filter((s) => (s as any).enabled);
console.log(`Students total=${st.length} enabled=${enabled.length}`);
const byClass: Record<string, number> = {};
for (const s of enabled) byClass[(s as any).classId || "—"] = (byClass[(s as any).classId || "—"] || 0) + 1;
console.log("enabled by classId:", JSON.stringify(byClass, null, 0));
const cls = await db.select().from(classes);
console.log("classes:", cls.map((c: any) => `${c.id}=${c.name}`).join(", "));
const s = await db.select().from(settings);
console.log("settings rows:", s.length, s.map((r: any) => ({ aiProvider: r.aiProvider })));
process.exit(0);
