-- AlterTable
-- Settings > "Show tips and prompts" (growth-prompt kill switch). NOT NULL
-- DEFAULT true so every existing row keeps seeing prompts until the user
-- turns them off — the switch is an opt-out, not consent.
ALTER TABLE "public"."users" ADD COLUMN     "growth_prompts_enabled" BOOLEAN NOT NULL DEFAULT true;
