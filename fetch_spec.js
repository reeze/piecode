import https from 'node:https';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  // Try the mintlify docs repo for agentskills
  const urls = [
    'https://raw.githubusercontent.com/mintlify/docs/main/content/settings.json',
    'https://raw.githubusercontent.com/mintlify/docs/main/content/agentskills.json',
    'https://raw.githubusercontent.com/agent-skills/spec/main/README.md',
    'https://raw.githubusercontent.com/agent-skills/spec/main/SPEC.md',
    'https://raw.githubusercontent.com/agent-skill-protocol/spec/main/README.md',
  ];
  
  for (const url of urls) {
    try {
      console.log('Trying:', url);
      const content = await fetchUrl(url);
      if (content.length > 100 && (content.includes('skill') || content.includes('extension') || content.includes('triggers'))) {
        console.log('Found:', content.slice(0, 3000));
        break;
      }
    } catch (e) {
      console.log('Error:', e.message);
    }
  }
}

main().catch(console.error);
