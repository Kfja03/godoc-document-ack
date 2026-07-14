import { createApp } from "./app";

const app = createApp();
const port = Number(process.env.PORT || 4000);

app.listen(port, () => {
  console.log(`GoDoc document-ack API listening on http://localhost:${port}`);
});
