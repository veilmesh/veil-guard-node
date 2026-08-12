export interface KmsConfig {
  keyId: string;
  provider?: 'aws' | 'gcp';
}
