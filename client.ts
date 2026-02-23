/**
 * Membrane gRPC client wrapper.
 * Connects to the Membrane sidecar and provides typed method calls.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface GrpcClient {
  [method: string]: (
    payload: Record<string, unknown>,
    metadata: grpc.Metadata,
    callback: (err: grpc.ServiceError | null, response: unknown) => void
  ) => void;
  close(): void;
}

export class MembraneClient {
  private client: GrpcClient;

  constructor(private endpoint: string, customProtoPath?: string) {
    const protoPath = customProtoPath || path.join(__dirname, 'assets/proto/membrane/v1/membrane.proto');
    
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [path.dirname(path.dirname(path.dirname(protoPath)))]
    });

    const membraneProto = grpc.loadPackageDefinition(packageDefinition) as unknown as Record<string, Record<string, Record<string, { new(endpoint: string, creds: grpc.ChannelCredentials): GrpcClient }>>>;
    this.client = new membraneProto.membrane.v1.MembraneService(
      this.endpoint,
      grpc.credentials.createInsecure()
    );
  }

  async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const metadata = new grpc.Metadata();
      const apiKey = process.env.MEMBRANE_API_KEY;
      if (apiKey) {
        metadata.add('authorization', apiKey);
      }

      if (typeof this.client[method] !== 'function') {
        reject(new Error(`Unknown gRPC method: ${method}`));
        return;
      }

      this.client[method](payload, metadata, (err: grpc.ServiceError | null, response: unknown) => {
        if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      });
    });
  }

  close(): void {
    this.client.close();
  }
}
