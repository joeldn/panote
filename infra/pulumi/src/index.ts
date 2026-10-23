import * as pulumi from '@pulumi/pulumi';

import { createInfra } from './infra.js';
import { readSettings } from './settings.js';

// The program entry (package.json "main", built to dist/). Everything it
// declares is in infra.ts; this only wires in the stack's config.
const settings = readSettings(pulumi.getStack(), new pulumi.Config());
const infra = createInfra(settings);

export const zoneId = infra.zoneId;
export const bucketName = infra.bucketName;
export const uploadsQueueId = infra.uploadsQueueId;
export const deadLetterQueueId = infra.deadLetterQueueId;
export const cdnHost = infra.cdnHost;
