ALTER TABLE "User"
  ALTER COLUMN "passwordHash" DROP NOT NULL,
  ADD COLUMN "googleSubject" TEXT,
  ADD COLUMN "appleSubject" TEXT;

CREATE UNIQUE INDEX "User_googleSubject_key" ON "User"("googleSubject");
CREATE UNIQUE INDEX "User_appleSubject_key" ON "User"("appleSubject");
