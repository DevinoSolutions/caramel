import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", ["POST"]);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    /* ---------- normalise & validate body ---------- */
    let body = {};
    try {
        body =
            typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    } catch {
        /* malformed JSON → keep body empty */
    }


    const q = String(body.query || "").trim();


    if (!q) return res.status(200).json({sites: []});

    const likePattern = `%${q}%`;


    try {

        const rows = await prisma.$queryRaw`
            SELECT DISTINCT c.site,
                   COALESCE(similarity(c.site, ${q}), 0) as sim_score
            FROM "Coupon" c
            WHERE c.site ILIKE ${likePattern}
               OR similarity(c.site, ${q}) > 0.25
            ORDER BY sim_score DESC, c.site ASC
        `;


        const sites = rows.map((r) => r.site);
        return res.status(200).json({sites});
    } catch (err) {
        console.error("Database error:", err);
        console.error("Error details:", {
            message: err.message,
            code: err.code,
            stack: err.stack
        });
        return res.status(500).json({error: "Search failed", details: err.message});
    }
}