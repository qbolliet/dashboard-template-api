{{/*
Expand the name of the chart.
*/}}
{{- define "dta.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "dta.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version as used by the chart label.
*/}}
{{- define "dta.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "dta.labels" -}}
helm.sh/chart: {{ include "dta.chart" . }}
{{ include "dta.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "dta.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dta.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "dta.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "dta.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Image reference. Falls back to .Chart.AppVersion when image.tag is empty.
*/}}
{{- define "dta.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end }}

{{/*
Name of the Secret holding application secrets.
Either an externally-managed one (secrets.existingSecret) or the chart-rendered one.
*/}}
{{- define "dta.appSecretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-app" (include "dta.fullname" .) -}}
{{- end -}}
{{- end }}

{{/*
Name of the Secret holding the Redis password.
When redis.enabled=true, this is the Secret auto-managed by the Bitnami sub-chart.
*/}}
{{- define "dta.redisAuthSecretName" -}}
{{- printf "%s-redis" .Release.Name -}}
{{- end }}

{{/*
Name of the ConfigMap.
*/}}
{{- define "dta.configMapName" -}}
{{- printf "%s-config" (include "dta.fullname" .) -}}
{{- end }}

{{/*
Hostname of the in-chart Redis master, when redis.enabled is true.
Bitnami names the master service "{{ .Release.Name }}-redis-master".
*/}}
{{- define "dta.redisHost" -}}
{{- if .Values.redis.enabled -}}
{{- printf "%s-redis-master" .Release.Name -}}
{{- else -}}
{{- required "config.REDIS_HOST must be set when redis.enabled=false" (index .Values.config "REDIS_HOST") -}}
{{- end -}}
{{- end }}
