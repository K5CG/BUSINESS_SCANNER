export const uuid = {
  v4: () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
};
