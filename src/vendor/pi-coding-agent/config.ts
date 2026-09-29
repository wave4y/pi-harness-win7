import * as path from 'path';
// The Web host always uses inMemory or an explicit path. Never select a user's
// global Pi folder implicitly through this compatibility module.
export const getAgentDir = () => path.resolve('.state', 'pi');
export const getSessionsDir = () => path.join(getAgentDir(), 'sessions');
