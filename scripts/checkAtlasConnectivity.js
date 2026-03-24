require('dotenv').config();

const dns = require('node:dns').promises;
const tls = require('node:tls');

const DEFAULT_PORT = 27017;
const CONNECT_TIMEOUT_MS = 10000;

const fail = (msg, err) => {
  console.error(`❌ ${msg}`);
  if (err?.message) {
    console.error(`   ${err.message}`);
  }
  process.exit(1);
};

const parseMongoHosts = (uri) => {
  if (!uri.startsWith('mongodb://')) {
    return [];
  }

  const withoutProtocol = uri.replace('mongodb://', '');
  const [authAndHosts] = withoutProtocol.split('/');
  const hostsPart = authAndHosts.includes('@')
    ? authAndHosts.split('@').slice(-1)[0]
    : authAndHosts;

  return hostsPart
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, port] = entry.split(':');
      return { host, port: Number(port || DEFAULT_PORT) };
    });
};

const tlsCheck = (host, port = DEFAULT_PORT) => new Promise((resolve, reject) => {
  const socket = tls.connect(
    {
      host,
      port,
      servername: host,
      rejectUnauthorized: true
    },
    () => {
      socket.end();
      resolve();
    }
  );

  socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
    socket.destroy(new Error(`timeout after ${CONNECT_TIMEOUT_MS}ms`));
  });

  socket.on('error', reject);
});

const run = async () => {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) fail('MONGODB_URI is missing');

  console.log('🔎 Checking MongoDB connectivity...');

  if (uri.startsWith('mongodb+srv://')) {
    const parsed = new URL(uri);
    const clusterHost = parsed.hostname;
    console.log(`- SRV host: ${clusterHost}`);

    let srvRecords = [];
    try {
      srvRecords = await dns.resolveSrv(`_mongodb._tcp.${clusterHost}`);
    } catch (err) {
      fail(`SRV DNS lookup failed for ${clusterHost}`, err);
    }

    if (!srvRecords.length) {
      fail(`No SRV records found for ${clusterHost}`);
    }

    console.log(`- SRV records: ${srvRecords.length}`);
    for (const record of srvRecords) {
      console.log(`  -> ${record.name}:${record.port}`);
      try {
        await tlsCheck(record.name, record.port);
        console.log('     TLS OK');
      } catch (err) {
        fail(`TLS failed to ${record.name}:${record.port}`, err);
      }
    }
  } else {
    const hosts = parseMongoHosts(uri);
    if (!hosts.length) {
      fail('Unsupported Mongo URI format. Use mongodb+srv:// or mongodb://');
    }

    for (const { host, port } of hosts) {
      console.log(`- Host: ${host}:${port}`);
      try {
        const ips = await dns.lookup(host, { all: true });
        console.log(`  DNS OK (${ips.length} IPs)`);
      } catch (err) {
        fail(`DNS lookup failed for ${host}`, err);
      }

      try {
        await tlsCheck(host, port);
        console.log('  TLS OK');
      } catch (err) {
        fail(`TLS failed to ${host}:${port}`, err);
      }
    }
  }

  console.log('✅ Atlas DNS/TLS connectivity looks good from this server');
  process.exit(0);
};

run().catch((err) => fail('Unexpected diagnostic error', err));
