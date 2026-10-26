import type { Server } from "node:http";
import { ensureToken, type Config } from "./config.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { createDaemon } from "./http.js";
import { LiveClients, type LiveClientsOptions } from "./live-clients.js";
import { Store } from "./store.js";

export interface RunningDaemon {
  server: Server;
  store: Store;
  dispatcher: Dispatcher;
  live: LiveClients;
  token: string;
  close(): Promise<void>;
}

export function startDaemon(config: Config, dispatch: DispatcherOptions = {}, liveOptions: LiveClientsOptions = {}): Promise<RunningDaemon> {
  const token = ensureToken(config.tokenPath);
  const store = new Store(config.dbPath);
  const dispatcher = new Dispatcher(store, dispatch);
  const live = new LiveClients(store, liveOptions);
  const server = createDaemon({
    store,
    host: config.host,
    policy: { port: config.port, token, allowedOrigins: config.allowedOrigins },
    pairingPath: config.pairingPath,
    dispatcher,
    live,
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
        live,
        token,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              live.close();
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
