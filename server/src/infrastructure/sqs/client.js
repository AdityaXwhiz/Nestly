import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../../config/env.js';

const sqsConfig = {
  region: env.AWS_REGION,
};

if (env.SQS_ENDPOINT) {
  sqsConfig.endpoint = env.SQS_ENDPOINT;
}

// Change #9: Static credentials only when provided (defaulted only when SQS_ENDPOINT is set)
if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
  sqsConfig.credentials = {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
}

export const sqsClient = new SQSClient(sqsConfig);

export const QUEUE_DEFINITIONS = {
  notifications: {
    name: 'notifications',
    dlqName: 'notifications-dlq',
    url: env.SQS_QUEUE_URL_NOTIFICATIONS,
    dlqUrl: `${env.SQS_QUEUE_URL_NOTIFICATIONS}-dlq`,
  },
  'provider-actions': {
    name: 'provider-actions',
    dlqName: 'provider-actions-dlq',
    url: env.SQS_QUEUE_URL_PROVIDER_ACTIONS,
    dlqUrl: `${env.SQS_QUEUE_URL_PROVIDER_ACTIONS}-dlq`,
  },
  analytics: {
    name: 'analytics',
    dlqName: 'analytics-dlq',
    url: env.SQS_QUEUE_URL_ANALYTICS,
    dlqUrl: `${env.SQS_QUEUE_URL_ANALYTICS}-dlq`,
  },
  'search-index': {
    name: 'search-index',
    dlqName: 'search-index-dlq',
    url: env.SQS_QUEUE_URL_SEARCH_INDEX,
    dlqUrl: `${env.SQS_QUEUE_URL_SEARCH_INDEX}-dlq`,
  },
};
