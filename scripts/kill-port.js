const { execSync } = require('child_process');

const port = process.argv[2] || '5177';
const portSuffix = `:${port}`;

function lineUsesPort(line) {
  const parts = line.trim().split(/\s+/);
  const localAddress = parts[1] || '';
  return localAddress.endsWith(portSuffix);
}

function killOnWindows() {
  try {
    const output = execSync('netstat -ano | findstr LISTENING', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const pids = [
      ...new Set(
        output
          .split('\n')
          .filter(lineUsesPort)
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid) => pid && pid !== '0' && /^\d+$/.test(pid))
      ),
    ];

    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        console.log(`Chiuso processo PID ${pid} sulla porta ${port}`);
      } catch {
        // process already gone
      }
    }

    if (pids.length === 0) {
      console.log(`Porta ${port} già libera.`);
    }
  } catch {
    console.log(`Porta ${port} già libera.`);
  }
}

killOnWindows();
