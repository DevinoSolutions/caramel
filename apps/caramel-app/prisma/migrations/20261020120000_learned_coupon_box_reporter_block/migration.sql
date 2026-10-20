-- The serving rule now also wants confirmations from at least 2 wider blocks
-- (/16 IPv4, /32 IPv6). Additive and nullable: a row written before this
-- counts toward no block.
ALTER TABLE "learned_coupon_box_reporters" ADD COLUMN "block_hash" TEXT;
