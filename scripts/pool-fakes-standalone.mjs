// Debug: run the pool fakes standalone so curl/electron can probe them.
import { startPoolFakes } from './pool-fakes.mjs';

const f = await startPoolFakes();
console.log('fakes up:', JSON.stringify(f.ports), 'sources:', f.sourcesEnv.slice(0, 80) + '...');
setInterval(() => { }, 10000);   // hold open
