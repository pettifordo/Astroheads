const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3001;
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));
app.listen(PORT, () => console.log(`Astroheads running at http://localhost:${PORT}`));
