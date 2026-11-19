#!/bin/bash
# Cria as filas SQS FIFO do serviço (executado pelo LocalStack no ready.d).
#
#   wager-transactions.fifo      entrada (WagerTransactionRequested) ── redrive ──► wager-transactions-dlq.fifo
#   wager-events.fifo            saída   (eventos do outbox)         ── redrive ──► wager-events-dlq.fifo
#
# maxReceiveCount=5: depois de 5 recebimentos sem ack, o SQS move a mensagem para a DLQ.
# O consumer aplica o mesmo limite (INBOX_MAX_RECEIVE_COUNT) para classificar o motivo.

set -e

create_fifo_queue() {
  awslocal sqs create-queue \
    --queue-name "$1" \
    --attributes FifoQueue=true,ContentBasedDeduplication=true \
    --query QueueUrl --output text
}

queue_arn() {
  awslocal sqs get-queue-attributes \
    --queue-url "$1" --attribute-names QueueArn \
    --query 'Attributes.QueueArn' --output text
}

create_with_dlq() {
  local name="$1"
  local dlq_name="${name%.fifo}-dlq.fifo"

  echo "Creating $dlq_name ..."
  local dlq_url
  dlq_url=$(create_fifo_queue "$dlq_name")
  local dlq_arn
  dlq_arn=$(queue_arn "$dlq_url")

  echo "Creating $name (redrive -> $dlq_name) ..."
  local url
  url=$(create_fifo_queue "$name")
  # Sintaxe JSON: a forma abreviada (Chave=Valor) não aceita o JSON do RedrivePolicy.
  local redrive_policy="{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}"
  awslocal sqs set-queue-attributes \
    --queue-url "$url" \
    --attributes "{\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"$redrive_policy\"}"
}

create_with_dlq wager-transactions.fifo
create_with_dlq wager-events.fifo

echo "SQS queues ready."
