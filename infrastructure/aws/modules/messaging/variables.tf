variable "name_prefix" {
  type        = string
  description = "Resource name prefix (e.g. nestly-dev)"
}

variable "queue_names" {
  type        = list(string)
  description = "Primary SQS queue names paired with matching <name>-dlq dead-letter queues"
  default = [
    "notifications",
    "provider-actions",
    "analytics",
    "search-index",
  ]
}

variable "max_receive_count" {
  type        = number
  description = "SQS redrive maxReceiveCount before moving messages to the DLQ"
  default     = 5
}

variable "visibility_timeout_seconds" {
  type        = number
  description = "Visibility timeout for primary SQS queues"
  default     = 60
}

variable "tags" {
  type        = map(string)
  description = "Common resource tags"
  default     = {}
}
