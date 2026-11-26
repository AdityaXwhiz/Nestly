import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../../config/env.js';

/**
 * Builds SQSClient configuration, omitting endpoint and static credentials in AWS IAM environments.
 */
export function buildSqsClientConfig(envConfig = env) {
  const sqsConfig = {
    region: envConfig.AWS_REGION,
  };

  if (envConfig.SQS_ENDPOINT) {
    sqsConfig.endpoint = envConfig.SQS_ENDPOINT;
  }

  // Change #9: Static credentials only when provided (defaulted only when SQS_ENDPOINT is set)
  if (envConfig.AWS_ACCESS_KEY_ID && envConfig.AWS_SECRET_ACCESS_KEY) {
    sqsConfig.credentials = {
      accessKeyId: envConfig.AWS_ACCESS_KEY_ID,
      secretAccessKey: envConfig.AWS_SECRET_ACCESS_KEY,
    };
  }

  return sqsConfig;
}

export const sqsClient = new SQSClient(buildSqsClientConfig(env));

export const QUEUE_DEFINITIONS = {
  notifications: {
    name: 'notifications',
    dlqName: 'notifications-dlq',
    url: env.SQS_QUEUE_URL_NOTIFICATIONS,
    dlqUrl: env.SQS_QUEUE_URL_NOTIFICATIONS_DLQ || `${env.SQS_QUEUE_URL_NOTIFICATIONS}-dlq`,
  },
  'provider-actions': {
    name: 'provider-actions',
    dlqName: 'provider-actions-dlq',
    url: env.SQS_QUEUE_URL_PROVIDER_ACTIONS,
    dlqUrl: env.SQS_QUEUE_URL_PROVIDER_ACTIONS_DLQ || `${env.SQS_QUEUE_URL_PROVIDER_ACTIONS}-dlq`,
  },
  analytics: {
    name: 'analytics',
    dlqName: 'analytics-dlq',
    url: env.SQS_QUEUE_URL_ANALYTICS,
    dlqUrl: env.SQS_QUEUE_URL_ANALYTICS_DLQ || `${env.SQS_QUEUE_URL_ANALYTICS}-dlq`,
  },
  'search-index': {
    name: 'search-index',
    dlqName: 'search-index-dlq',
    url: env.SQS_QUEUE_URL_SEARCH_INDEX,
    dlqUrl: env.SQS_QUEUE_URL_SEARCH_INDEX_DLQ || `${env.SQS_QUEUE_URL_SEARCH_INDEX}-dlq`,
  },
};
