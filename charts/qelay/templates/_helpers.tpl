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
.command, .args, .port (adds probes on .livePath and .readyPath), .resources, .serviceAccountName.
*/}}
{{- define "qelay.deployment" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "qelay.fullname" .root }}-{{ .component }}
  labels:
    {{- include "qelay.labels" . | nindent 4 }}
spec:
  replicas: {{ .replicas }}
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
