#!/bin/bash

# Define an array of pod labels
POD_LABELS=("app=meilisearch" "app=mongodb" "app=rag")

i=0  # Initialize a counter for local ports

# Loop through each pod label
for POD_LABEL in "${POD_LABELS[@]}"; do
  # Get the pod name
  POD_NAME=$(kubectl get pods -l $POD_LABEL -o go-template --template '{{range .items}}{{.metadata.name}}{{"\n"}}{{end}}')

  # Get the pod's port (assuming the first container's first port)
  #POD_PORT=$(kubectl get pod $POD_NAME -o go-template --template '{{(index .spec.containers 0).ports 0).containerPort}}')
  POD_PORT=$(kubectl get pod $POD_NAME -o jsonpath='{.spec.containers[0].ports[0].containerPort}')

  # Forward the port, using a different local port for each pod
  #LOCAL_PORT=$((8000 + $((i++))))
  kubectl port-forward $POD_NAME $POD_PORT:$POD_PORT &

  echo "Port forwarding established: localhost:$POD_PORT -> $POD_NAME:$POD_PORT"
done

# Keep the script running until interrupted
trap "kill 0" EXIT
wait