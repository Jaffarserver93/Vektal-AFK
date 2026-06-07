import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";

const router: IRouter = Router();
const UPLOADS_DIR = "/tmp/bot-uploads";
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Accept raw binary upload: curl -X POST --data-binary @file.png /api/upload?name=file.png
router.post("/upload", (req, res) => {
  const name = (req.query["name"] as string) || `upload-${Date.now()}.png`;
  const safe = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const dest = path.join(UPLOADS_DIR, safe);
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    fs.writeFileSync(dest, Buffer.concat(chunks));
    res.json({ ok: true, file: safe, view: `/api/uploads/${safe}` });
  });
  req.on("error", (e) => res.status(500).json({ ok: false, error: e.message }));
});

// Serve uploaded files
router.get("/uploads/:name", (req, res) => {
  const safe = path.basename(req.params["name"]!).replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = path.join(UPLOADS_DIR, safe);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", "image/png");
  res.send(fs.readFileSync(file));
});

// List uploaded files
router.get("/uploads", (_req, res) => {
  const files = fs.existsSync(UPLOADS_DIR)
    ? fs.readdirSync(UPLOADS_DIR).filter(f => !f.startsWith("."))
    : [];
  res.json({ files });
});

export default router;
