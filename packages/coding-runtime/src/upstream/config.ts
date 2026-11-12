/** Host directory injection replaces Pi's process-global configuration discovery. */
export const CONFIG_DIR_NAME = '.pi';
export const isBunBinary = false;
export const isBundledNode = false;
export const APP_NAME = 'mkagent';

const source = 'https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent';
export const getDocsPath = () => `${source}/docs`;
export const getExamplesPath = () => `${source}/examples`;
export const getReadmePath = () => `${source}/README.md`;

export function getAgentDir(): never {
  throw new Error('The durable coding host must provide agentDir explicitly.');
}

export function getSessionsDir(): never {
  throw new Error('Durable owns session storage. Use the host session API.');
}
