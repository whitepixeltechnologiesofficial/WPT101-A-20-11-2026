/**
 * Start the WEB-R1.0 linking mock.
 *
 *   pnpm --filter @wpt/api-client mock          (port 4010, or MOCK_PORT)
 *
 * Then set API_BASE_URL=http://localhost:4010 in apps/web/.env.local and
 * open http://localhost:4010/__mock to act as the phone.
 */
import { startMockServer } from "./server.js";

const port = Number(process.env.MOCK_PORT ?? 4010);
const server = await startMockServer({ port, log: true });

const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
