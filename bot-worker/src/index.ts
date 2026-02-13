import { readConfig } from "./config.js";
import { createAppServer } from "./server.js";

const main = (): void => {
  const config = readConfig();
  const server = createAppServer(config);
  server.listen(config.port, () => {
    console.log(`bot-worker listening on :${config.port}`);
  });
};

main();
