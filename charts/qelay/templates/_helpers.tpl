{{- define "qelay.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end }}

{{- define "qelay.selector" -}}
app.kubernetes.io/name: qelay
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "qelay.labels" -}}
{{ include "qelay.selector" . }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
{{- end }}

{{/* repository:tag, the tag defaulting to the chart's appVersion. */}}
{{- define "qelay.image" -}}
{{- printf "%s:%s" .image.repository (.image.tag | default .root.Chart.AppVersion) -}}
{{- end }}

{{/* A map of extra variables as container env entries. */}}
{{- define "qelay.extraEnv" -}}
{{- range $name, $value := . }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}

{{/* The settings every process reads: .root, .poolSize, and optionally .urlKey. */}}
{{- define "qelay.env" -}}
{{- $db := .root.Values.database -}}
- name: QCLOUD_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ required "database.existingSecret is required: kubectl create secret generic <name> --from-literal=url=postgres://..." $db.existingSecret }}
      key: {{ .urlKey | default $db.urlKey }}
- name: QCLOUD_DATABASE_POOL_SIZE
  value: {{ .poolSize | quote }}
- name: QCLOUD_NAMESPACE
  value: {{ .root.Values.queueNamespace | quote }}
- name: QCLOUD_TRANSPORT
  value: {{ .root.Values.transport.kind | quote }}
{{- with .root.Values.transport.gcpProject }}
- name: QCLOUD_GCP_PROJECT
  value: {{ . | quote }}
{{- end }}
{{- with .root.Values.transport.awsRegion }}
- name: QCLOUD_AWS_REGION
  value: {{ . | quote }}
{{- end }}
{{- if ne $db.pooler "none" }}
- name: QCLOUD_DATABASE_POOLER
  value: {{ $db.pooler | quote }}
{{- end }}
{{- with $db.tls }}
- name: QCLOUD_DATABASE_TLS
  value: {{ . | quote }}
{{- end }}
{{- with $db.tlsCa }}
- name: QCLOUD_DATABASE_TLS_CA
  value: {{ . | quote }}
{{- end }}
{{- with .root.Values.webhooks.keySecret.name }}
- name: QCLOUD_WEBHOOK_KEY
  valueFrom:
    secretKeyRef:
      name: {{ . }}
      key: {{ $.root.Values.webhooks.keySecret.key }}
{{- end }}
{{- end }}

{{/*
One Deployment: .root, .component, .replicas, .image, .env (rendered list), and optionally
.command, .args, .port (adds probes on .livePath and .readyPath), .resources, .serviceAccountName,
.autoscaled (true: no `replicas`, the autoscaler owns the count).
*/}}
{{- define "qelay.deployment" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "qelay.fullname" .root }}-{{ .component }}
  labels:
    {{- include "qelay.labels" . | nindent 4 }}
spec:
  {{- if not .autoscaled }}
  replicas: {{ .replicas }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "qelay.selector" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "qelay.selector" . | nindent 8 }}
    spec:
      serviceAccountName: {{ .serviceAccountName | default (include "qelay.fullname" .root) }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
      {{- with .root.Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ .component }}
          image: {{ .image }}
          imagePullPolicy: {{ .root.Values.imagePullPolicy }}
          {{- with .command }}
          command: {{ toJson . }}
          {{- end }}
          {{- with .args }}
          args: {{ toJson . }}
          {{- end }}
          {{- if .port }}
          ports:
            - name: http
              containerPort: {{ .port }}
          livenessProbe:
            httpGet: { path: {{ .livePath }}, port: http }
          readinessProbe:
            httpGet: { path: {{ .readyPath }}, port: http }
          {{- end }}
          env:
            {{- .env | nindent 12 }}
          {{- with .resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: {}
{{- end }}

{{/* The most replicas a component can run: its autoscaling ceiling, or its fixed count. Takes the component's values. */}}
{{- define "qelay.replicasMax" -}}
{{- $auto := .autoscaling | default dict -}}
{{- if $auto.enabled }}{{ $auto.maxReplicas | default 10 }}{{ else }}{{ .replicas | default 1 }}{{ end -}}
{{- end }}

{{/*
The autoscaler and the disruption budget of one Deployment: .root, .component, .values (the component's values:
autoscaling, podDisruptionBudget, resources). With `autoscaling.triggers` it is a KEDA ScaledObject on those
triggers (a backlog: Pub/Sub, SQS); without, a HorizontalPodAutoscaler on CPU, which needs resources.requests.cpu.
*/}}
{{- define "qelay.scaling" -}}
{{- $name := printf "%s-%s" (include "qelay.fullname" .root) .component -}}
{{- $auto := .values.autoscaling | default dict -}}
{{- $pdb := .values.podDisruptionBudget | default dict -}}
{{- if $auto.enabled }}
---
{{- if $auto.triggers }}
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: {{ $name }}
  labels:
    {{- include "qelay.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    name: {{ $name }}
  minReplicaCount: {{ $auto.minReplicas | default 1 }}
  maxReplicaCount: {{ $auto.maxReplicas | default 10 }}
  pollingInterval: {{ $auto.pollingInterval | default 15 }}
  cooldownPeriod: {{ $auto.cooldownPeriod | default 300 }}
  triggers:
    {{- toYaml $auto.triggers | nindent 4 }}
{{- else }}
{{- if not (dig "requests" "cpu" "" (.values.resources | default dict)) }}
{{- fail (printf "%s: autoscaling on CPU needs resources.requests.cpu (or give autoscaling.triggers)" .component) }}
{{- end }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ $name }}
  labels:
    {{- include "qelay.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ $name }}
  minReplicas: {{ $auto.minReplicas | default 1 }}
  maxReplicas: {{ $auto.maxReplicas | default 10 }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ $auto.targetCPU | default 70 }}
{{- end }}
{{- end }}
{{- if $pdb.enabled }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ $name }}
  labels:
    {{- include "qelay.labels" . | nindent 4 }}
spec:
  {{- if $pdb.minAvailable }}
  minAvailable: {{ $pdb.minAvailable }}
  {{- else }}
  maxUnavailable: {{ $pdb.maxUnavailable | default 1 }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "qelay.selector" . | nindent 6 }}
{{- end }}
{{- end }}

{{/*
Fails the render when the fleet at its largest needs more connections than `database.maxConnections`
(0: not checked; behind a pooler the pooler's own pool is the limit, so not checked either). The same sum as
packages/store-postgres/src/connection/budget.ts: every process's pool, a LISTEN connection per worker on
the postgres transport, and 6 held back for the database.
*/}}
{{- define "qelay.checkConnections" -}}
{{- $v := .Values -}}
{{- $limit := int $v.database.maxConnections -}}
{{- if and (gt $limit 0) (eq $v.database.pooler "none") -}}
{{- $listen := ternary 1 0 (eq $v.transport.kind "postgres") -}}
{{- $total := 6 -}}
{{- $total = add $total (mul (int (include "qelay.replicasMax" $v.api)) (int $v.api.poolSize)) -}}
{{- if $v.ingest.enabled }}{{ $total = add $total (mul (int (include "qelay.replicasMax" $v.ingest)) (int $v.ingest.poolSize)) }}{{ end -}}
{{- if $v.tick.loop.enabled }}{{ $total = add $total (mul (int $v.tick.loop.replicas) (int $v.tick.loop.poolSize)) }}{{ end -}}
{{- if $v.tick.cron.enabled }}{{ $total = add $total (int $v.tick.cron.poolSize) }}{{ end -}}
{{- if $v.webhooks.sender.enabled }}{{ $total = add $total (mul (int (include "qelay.replicasMax" $v.webhooks.sender)) (int $v.webhooks.sender.poolSize)) }}{{ end -}}
{{- range $v.workers }}{{ $total = add $total (mul (int (include "qelay.replicasMax" .)) (add (int (.poolSize | default 2)) $listen)) }}{{ end -}}
{{- if gt (int $total) $limit -}}
{{- fail (printf "At its largest the fleet needs %d database connections, but database.maxConnections is %d. Lower a maxReplicas or poolSize, raise max_connections, or set database.pooler to transaction." (int $total) $limit) -}}
{{- end -}}
{{- end -}}
{{- end }}
