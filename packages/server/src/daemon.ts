import type { Server } from "node:http";
import { ensureToken, type Config } from "./config.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { createDaemon } from "./http.js";
import { Store } from "./store.js";

export interface RunningDaemon {
  server: Server;
  store: Store;
  dispatcher: Dispatcher;
  token: string;
  close(): Promise<void>;
}

export function startDaemon(config: Config, dispatch: DispatcherOptions = {}): Promise<RunningDaemon> {
  const token = ensureToken(config.tokenPath);
  const store = new Store(config.dbPath);
  const dispatcher = new Dispatcher(store, dispatch);
  const server = createDaemon({
    store,
    host: config.host,
    policy: { port: config.port, token, allowedOrigins: config.allowedOrigins },
    pairingPath: config.pairingPath,
    dispatcher,
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      store.close();
      reject(error);
    });
    server.listen(config.port, config.host, () => {
      resolve({
        server,
        store,
        dispatcher,
        token,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              void dispatcher.close().finally(() => {
                store.close();
                done();
              });
            });
          }),
      });
    });
  });
}
