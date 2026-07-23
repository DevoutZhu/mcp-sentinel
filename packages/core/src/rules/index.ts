import { ValidationRule } from '../validator.js';
import { protocolRules } from './protocol.js';
import { capabilityRules } from './capabilities.js';

export const ALL_RULES: ValidationRule[] = [
  ...protocolRules,
  ...capabilityRules,
];
