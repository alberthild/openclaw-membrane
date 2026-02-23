import { MembraneClient } from '../client.js';
import { mapEvent } from '../mapping.js';
import { ReliabilityManager } from '../buffer.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
    console.log("🚀 Starting Intensive Stress Test for @vainplex/openclaw-membrane...");
    
    const client = new MembraneClient('localhost:50051', path.join(__dirname, '../assets/proto/membrane/v1/membrane.proto'));
    
    const reliability = new ReliabilityManager(1000, async (item) => {
        await client.call(item.method, item.payload);
    });

    console.log("📦 Ingesting 500 events (Mixed Sensitivity & Types)...");
    
    for (let i = 0; i < 500; i++) {
        const type = i % 10 === 0 ? 'credential_update' : (i % 3 === 0 ? 'after_tool_call' : 'message_received');
        const sensitivity = i % 50 === 0 ? 'hyper' : undefined;
        
        const event: any = {
            id: `stress-test-${i}`,
            type: type,
            ts: Date.now(),
            payload: { message: `Stress test message ${i}`, object: { index: i } },
            context: { 
                sensitivity: sensitivity,
                isPrivate: i % 5 === 0,
                channelType: i % 2 === 0 ? 'dm' : 'group'
            }
        };

        const mapped = mapEvent(event, 'low');
        if (mapped) {
            reliability.enqueue(mapped.method as any, mapped.payload);
        }
        
        if (i % 100 === 0) console.log(`  ...enqueued ${i} events`);
    }

    console.log("⏳ Waiting for processing to complete...");
    await reliability.flush(30000);
    console.log("✅ Flush complete.");
    client.close();
}

run().catch(console.error);
