import { uuid } from 'expo-modules-core';

/** ID univoci nativi per React Native. */
export function createId(): string {
  return uuid.v4();
}