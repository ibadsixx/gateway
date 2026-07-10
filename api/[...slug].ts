export default function handler(req: any, res: any) {
  res.status(200).json({
    ok: true,
    method: req.method,
    url: req.url,
    path: req.url,
    timestamp: new Date().toISOString(),
  });
}
