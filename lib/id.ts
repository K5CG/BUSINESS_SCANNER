import { v4 as uuidv4 } from 'uuid';

/** ID univoci compatibili React Native e test Node. */
export function createId(): string {
  return uuidv4();
}
