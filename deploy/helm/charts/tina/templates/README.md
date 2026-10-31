# tina chart · templates

Kubernetes manifests rendered by the `tina` Helm chart — one `deployment-*.yaml` per service (gateway, admin-api, meeting-api, agent-api, terminal, runtime, redis, pgbouncer, …) plus supporting resources. Values come from the chart `values.yaml`.

Object storage is the operator's own S3 (`storage.s3`): `configmap-s3-client.yaml` renders meeting-api's S3 client config, and `validate-storage.yaml` renders nothing — it runs the storage guards (`tina.storage.validate` in `_helpers.tpl`) that refuse a render without `storage.s3` or with a leftover `minio.enabled: true`.
