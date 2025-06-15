import prisma from "@/lib/prisma";

export default async function handler(req, res) {
    if (req.method !== "GET") {
        res.setHeader("Allow", ["GET"]);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
        const topSites = await prisma.coupon.groupBy({
            by: ['site'],
            _count: {
                id: true
            },
            orderBy: {
                _count: {
                    id: 'desc'
                }
            },
            take: 4
        });

        const sites = topSites.map(item => item.site);

        return res.status(200).json({ sites });
    } catch (err) {
        console.error("Error fetching top sites:", err);
        return res.status(500).json({ error: "Failed to fetch top sites" });
    }
}