import { createServer, getServerPort } from '@devvit/web/server';

import { onRequest } from './server.ts';

const server = createServer(onRequest);
const port = getServerPort();

server.on('error', (error) => {
  console.error(`Server error: ${error.stack}`);
});

server.listen(port, () => {
  console.log(`Reddit Site Status server listening on port ${port}.`);
});
