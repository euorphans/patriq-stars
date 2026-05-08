#!/usr/bin/env bash
#
# deploy.sh — универсальный скрипт деплоя stars-bot в k3s
#
# Использование:
#   ./scripts/deploy.sh              # полный деплой (первый раз на новом сервере)
#   ./scripts/deploy.sh --update     # обновление кода (git pull + build + restart)
#   ./scripts/deploy.sh --hotfix     # быстрый деплой с Docker-кешем (~30с)
#   ./scripts/deploy.sh --update-db  # обновление кода + prisma db push (если менялась схема)
#   ./scripts/deploy.sh --restart    # перезапуск без пересборки
#   ./scripts/deploy.sh --status     # показать статус всех компонентов
# Внешний вход: Google Cloud Load Balancer (NEG / порт на ВМ).
#   ./scripts/deploy.sh --logs       # логи бота (follow)
#   ./scripts/deploy.sh --merge-legacy /path/to.dump   # дамп → import_legacy → слияние в production
#   MERGE_LEGACY_USE_EXISTING_IMPORT=1 ./scripts/deploy.sh --merge-legacy   # данные уже в import_legacy
#   ./scripts/deploy.sh --destroy    # удалить всё (осторожно!)
#
# Первый деплой: .env → ./scripts/deploy.sh

set -euo pipefail

# ─── Конфигурация ────────────────────────────────────
NAMESPACE="stars-bot"
IMAGE="stars-bot:latest"
FULL_IMAGE="docker.io/library/${IMAGE}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
K8S_DIR="${PROJECT_DIR}/k8s"

# k3s: /etc/rancher/k3s/k3s.yaml часто только root; обёртка kubectl может подставлять его при пустом KUBECONFIG.
# Один раз скопируй: mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown "$(id -u):$(id -g)" ~/.kube/config
# Для интерактивного kubectl добавь в ~/.bashrc: export KUBECONFIG="$HOME/.kube/config"
ensure_kubeconfig_readable() {
  local home_cfg="${HOME}/.kube/config"
  [[ -r "$home_cfg" ]] || return 0
  if [[ -z "${KUBECONFIG:-}" ]]; then
    export KUBECONFIG="$home_cfg"
    return 0
  fi
  if [[ ! -r "$KUBECONFIG" ]]; then
    export KUBECONFIG="$home_cfg"
  fi
}

# ─── Цвета ──────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR ]${NC} $*" >&2; }

# ─── Проверки ────────────────────────────────────────
check_tools() {
  local missing=()
  for tool in kubectl docker; do
    command -v "$tool" &>/dev/null || missing+=("$tool")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    err "Не найдены: ${missing[*]}"
    exit 1
  fi
  kubectl cluster-info &>/dev/null || { err "Нет подключения к k8s кластеру"; exit 1; }
}

check_env_file() {
  if [ ! -f "${PROJECT_DIR}/.env" ]; then
    err "Файл .env не найден!"
    err "Скопируй .env.example → .env и заполни:"
    err "  cp .env.example .env && nano .env"
    exit 1
  fi
}

# ─── Сборка и импорт образа ─────────────────────────
build_and_import() {
  local use_cache="${1:-no}"
  if [ "$use_cache" = "yes" ]; then
    log "Сборка Docker-образа (с кешем)..."
    docker build -t "$IMAGE" -f "${PROJECT_DIR}/Dockerfile" "${PROJECT_DIR}"
  else
    log "Сборка Docker-образа (--no-cache)..."
    docker build --no-cache -t "$IMAGE" -f "${PROJECT_DIR}/Dockerfile" "${PROJECT_DIR}"
  fi
  ok "Образ собран"

  log "Импорт образа в k3s..."
  sudo k3s ctr images rm "$FULL_IMAGE" 2>/dev/null || true
  docker save "$IMAGE" | sudo k3s ctr images import -
  ok "Образ импортирован"
}

# ─── Namespace и секреты ─────────────────────────────
ensure_namespace() {
  if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
    log "Создание namespace ${NAMESPACE}..."
    kubectl create namespace "$NAMESPACE"
  fi
}

ensure_secrets() {
  if ! kubectl get secret stars-bot-secrets -n "$NAMESPACE" &>/dev/null; then
    log "Создание секретов из .env..."
    kubectl create secret generic stars-bot-secrets \
      --namespace="$NAMESPACE" \
      --from-env-file="${PROJECT_DIR}/.env"
    ok "Секреты созданы"
  else
    ok "Секреты уже существуют"
    warn "Чтобы обновить секреты: ./scripts/deploy.sh --update-secrets"
  fi
}

update_secrets() {
  log "Обновление секретов из .env..."
  kubectl delete secret stars-bot-secrets -n "$NAMESPACE" --ignore-not-found
  kubectl create secret generic stars-bot-secrets \
    --namespace="$NAMESPACE" \
    --from-env-file="${PROJECT_DIR}/.env"
  ok "Секреты обновлены"
}

# ─── Инфраструктура ──────────────────────────────────
deploy_infra() {
  log "Деплой инфраструктуры..."

  # Namespace
  kubectl apply -f "${K8S_DIR}/namespace.yaml" 2>/dev/null || true

  # ConfigMap
  if [ -f "${K8S_DIR}/configmap.yaml" ]; then
    kubectl apply -f "${K8S_DIR}/configmap.yaml"
  fi

  # Redis
  log "  Redis..."
  kubectl apply -f "${K8S_DIR}/redis/statefulset.yaml"
  kubectl rollout status statefulset/redis-master -n "$NAMESPACE" --timeout=120s

  # PostgreSQL (секрет stars-bot-secrets уже должен содержать POSTGRES_* и DATABASE_URL)
  if [ -f "${K8S_DIR}/postgresql/statefulset.yaml" ]; then
    log "  PostgreSQL..."
    kubectl apply -f "${K8S_DIR}/postgresql/statefulset.yaml"
    kubectl rollout status statefulset/postgresql-master -n "$NAMESPACE" --timeout=300s
  else
    warn "Нет ${K8S_DIR}/postgresql/statefulset.yaml — миграции должны ходить во внешнюю БД"
  fi

  ok "Инфраструктура готова"
}

# ─── Миграции ────────────────────────────────────────
run_migrations() {
  log "Запуск миграций Prisma..."

  kubectl delete pod prisma-push -n "$NAMESPACE" --ignore-not-found 2>/dev/null

  local DB_URL
  DB_URL=$(kubectl get secret stars-bot-secrets -n "$NAMESPACE" \
    -o jsonpath='{.data.DATABASE_URL}' | base64 -d)

  kubectl run prisma-push \
    --namespace="$NAMESPACE" \
    --image="$FULL_IMAGE" \
    --image-pull-policy=Never \
    --restart=Never \
    --env="DATABASE_URL=${DB_URL}" \
    --command -- npx prisma db push

  log "  Ожидание завершения..."
  for _ in $(seq 1 60); do
    local phase
    phase=$(kubectl get pod prisma-push -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Pending")
    case "$phase" in
      Succeeded) break ;;
      Failed)
        err "Миграция провалилась!"
        kubectl logs prisma-push -n "$NAMESPACE" 2>/dev/null || true
        kubectl delete pod prisma-push -n "$NAMESPACE" --ignore-not-found
        exit 1
        ;;
    esac
    sleep 2
  done

  kubectl logs prisma-push -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete pod prisma-push -n "$NAMESPACE" --ignore-not-found
  ok "Миграции выполнены"
}

# ─── Применение манифестов ────────────────────────────
apply_manifests() {
  log "Применение k8s-манифестов..."
  kubectl apply -f "${K8S_DIR}/deployment.yaml" -n "$NAMESPACE"
  for manifest in worker.yaml broadcast-worker.yaml screenshot-worker.yaml; do
    if [ -f "${K8S_DIR}/${manifest}" ]; then
      kubectl apply -f "${K8S_DIR}/${manifest}" -n "$NAMESPACE"
    fi
  done
  if [ -f "${K8S_DIR}/hpa.yaml" ]; then
    kubectl apply -f "${K8S_DIR}/hpa.yaml" -n "$NAMESPACE" 2>/dev/null || true
  fi
}

# ─── Перезапуск всех deployments ─────────────────────
restart_all_deployments() {
  log "Перезапуск deployments..."
  local deployments=(stars-bot stars-bot-worker stars-bot-broadcast-worker stars-bot-screenshot-worker)
  for dep in "${deployments[@]}"; do
    if kubectl get deployment "$dep" -n "$NAMESPACE" &>/dev/null; then
      kubectl rollout restart deployment "$dep" -n "$NAMESPACE"
      log "  Restarted $dep"
    fi
  done
  for dep in "${deployments[@]}"; do
    if kubectl get deployment "$dep" -n "$NAMESPACE" &>/dev/null; then
      kubectl rollout status deployment "$dep" -n "$NAMESPACE" --timeout=180s
    fi
  done
}

# ─── Деплой приложения ───────────────────────────────
deploy_app() {
  log "Деплой приложения..."

  # Подставить локальный образ и imagePullPolicy: Never
  sed \
    -e "s|image: registry.example.com/stars-bot:latest|image: ${FULL_IMAGE}|g" \
    -e 's|imagePullPolicy: Always|imagePullPolicy: Never|g' \
    "${K8S_DIR}/deployment.yaml" | kubectl apply -f -

  # Service (ClusterIP; снаружи — Google Cloud Load Balancer → NEG / порт на ноде)
  kubectl apply -f "${K8S_DIR}/service.yaml"

  # HPA (опционально)
  if [ -f "${K8S_DIR}/hpa.yaml" ]; then
    kubectl apply -f "${K8S_DIR}/hpa.yaml" 2>/dev/null || true
  fi

  # PDB (опционально)
  if [ -f "${K8S_DIR}/pdb.yaml" ]; then
    kubectl apply -f "${K8S_DIR}/pdb.yaml" 2>/dev/null || true
  fi

  # Ожидание
  log "  Ожидание раскатки..."
  kubectl rollout status deployment/stars-bot -n "$NAMESPACE" --timeout=180s
  ok "Приложение задеплоено"
}

# ─── Статус ──────────────────────────────────────────
show_status() {
  echo ""
  log "══════════ СТАТУС ══════════"
  echo ""

  log "Pods:"
  kubectl get pods -n "$NAMESPACE" -o wide 2>/dev/null || warn "Namespace не найден"
  echo ""

  log "CPU / Memory (kubectl top):"
  kubectl top pods -n "$NAMESPACE" 2>/dev/null || warn "metrics-server недоступен"
  echo ""

  log "HPA:"
  kubectl get hpa -n "$NAMESPACE" 2>/dev/null || warn "HPA не найден"
  echo ""

  log "Services:"
  kubectl get svc -n "$NAMESPACE" 2>/dev/null || true
  echo ""

  log "PVC:"
  kubectl get pvc -n "$NAMESPACE" 2>/dev/null || true
  echo ""

  # Image ID
  local img_id
  img_id=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=stars-bot \
    -o jsonpath='{.items[0].status.containerStatuses[0].imageID}' 2>/dev/null || echo "N/A")
  log "Image ID: ${img_id}"
  echo ""

  # Последние ошибки из логов
  log "Последние ERROR из логов (все поды, tail=50):"
  for pod in $(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=stars-bot \
    --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    kubectl logs -n "$NAMESPACE" "$pod" --tail=50 2>/dev/null \
      | grep "ERROR" | tail -5 \
      | sed "s/^/[$pod] /"
  done
  echo ""
}

# ─── Уничтожение ────────────────────────────────────
destroy() {
  echo ""
  warn "ЭТО УДАЛИТ ВСЁ: базу данных, Redis, бота!"
  read -p "Точно удалить? Введи 'yes' для подтверждения: " -r
  echo
  if [ "$REPLY" != "yes" ]; then
    log "Отменено."
    exit 0
  fi

  log "Удаление всего в namespace ${NAMESPACE}..."
  kubectl delete deployment --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete statefulset --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete pod --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete svc --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete pvc --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete secret --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete configmap --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete hpa --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete pdb --all -n "$NAMESPACE" 2>/dev/null || true
  kubectl delete namespace "$NAMESPACE" 2>/dev/null || true

  # Docker images
  docker rmi "$IMAGE" 2>/dev/null || true
  sudo k3s ctr images rm "$FULL_IMAGE" 2>/dev/null || true

  ok "Всё удалено"
}

# ─── Точка входа ─────────────────────────────────────
main() {
  ensure_kubeconfig_readable

  echo ""
  echo "═══════════════════════════════════"
  echo "  stars-bot deploy (k3s)"
  echo "═══════════════════════════════════"
  echo ""

  case "${1:-full}" in

    # ─── Полный деплой (первый раз) ─────────
    full)
      check_tools
      check_env_file
      log "Режим: ПОЛНЫЙ ДЕПЛОЙ"
      echo ""
      build_and_import
      ensure_namespace
      ensure_secrets
      deploy_infra
      run_migrations
      deploy_app
      show_status
      echo ""
      ok "Первый деплой завершён!"
      ok "Проверь бота — напиши ему /start в Telegram"
      ;;

    # ─── Обновление кода (без миграций) ─────
    --update)
      check_tools
      log "Режим: ОБНОВЛЕНИЕ КОДА"
      echo ""
      log "Pulling latest code..."
      cd "$PROJECT_DIR" && git pull origin dev
      build_and_import no
      apply_manifests
      restart_all_deployments
      show_status
      ok "Обновление завершено!"
      ;;

    # ─── Быстрый хотфикс (кеш Docker) ────
    --hotfix)
      check_tools
      log "Режим: ХОТФИКС (быстрая сборка с кешем)"
      echo ""
      log "Pulling latest code..."
      cd "$PROJECT_DIR" && git pull origin dev
      build_and_import yes
      apply_manifests
      restart_all_deployments
      ok "Хотфикс задеплоен!"
      ;;

    # ─── Обновление кода + Prisma миграции ──
    --update-db)
      check_tools
      log "Режим: ОБНОВЛЕНИЕ КОДА + PRISMA"
      echo ""
      log "Pulling latest code..."
      cd "$PROJECT_DIR" && git pull origin dev
      build_and_import no
      run_migrations
      restart_all_deployments
      show_status
      ok "Обновление завершено (с миграцией БД)!"
      ;;

    # ─── Перезапуск (без пересборки) ────────
    --restart)
      restart_all_deployments
      ok "Перезапуск завершён"
      ;;

    # ─── Обновить секреты из .env ───────────
    --update-secrets)
      check_env_file
      update_secrets
      restart_all_deployments
      ok "Секреты обновлены, бот перезапущен"
      ;;

    # ─── Логи ───────────────────────────────
    --logs)
      kubectl logs -l app.kubernetes.io/name=stars-bot -n "$NAMESPACE" -f --tail=50
      ;;

    # ─── Слияние дампа старой БД в production (без удаления текущих данных) ─
    --merge-legacy)
      if [ "${MERGE_LEGACY_USE_EXISTING_IMPORT:-0}" = "1" ]; then
        log "Слияние: данные уже в import_legacy — FDW + INSERT в production (merge-legacy-db.sh)…"
        MERGE_LEGACY_USE_EXISTING_IMPORT=1 bash "${PROJECT_DIR}/scripts/merge-legacy-db.sh"
        ok "Слияние завершено"
      else
        local mdump="${2:-}"
        if [ -z "$mdump" ]; then
          err "Укажи путь к дампу или MERGE_LEGACY_USE_EXISTING_IMPORT=1 если данные уже в import_legacy"
          exit 1
        fi
        if [ ! -f "$mdump" ]; then
          err "Файл не найден: $mdump"
          exit 1
        fi
        mdump="$(cd "$(dirname "$mdump")" && pwd)/$(basename "$mdump")"
        log "Слияние legacy → production (см. scripts/merge-legacy-db.sh)…"
        MERGE_LEGACY_DUMP="$mdump" bash "${PROJECT_DIR}/scripts/merge-legacy-db.sh"
        ok "Слияние завершено"
      fi
      ;;

    # ─── Prisma Studio ─────────────────────
    --studio)
      log "Запуск Prisma Studio..."
      kubectl delete pod prisma-studio -n "$NAMESPACE" --ignore-not-found 2>/dev/null

      local DB_URL
      DB_URL=$(kubectl get secret stars-bot-secrets -n "$NAMESPACE" \
        -o jsonpath='{.data.DATABASE_URL}' | base64 -d)

      kubectl run prisma-studio \
        --namespace="$NAMESPACE" \
        --image="$FULL_IMAGE" \
        --image-pull-policy=Never \
        --restart=Never \
        --env="DATABASE_URL=${DB_URL}" \
        --command -- npx prisma studio --port 5555 --hostname 0.0.0.0

      log "Ожидание запуска..."
      for _ in $(seq 1 30); do
        local phase
        phase=$(kubectl get pod prisma-studio -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Pending")
        if [ "$phase" = "Running" ]; then break; fi
        sleep 2
      done

      local SERVER_IP
      SERVER_IP=$(hostname -I | awk '{print $1}')
      ok "Prisma Studio запущен!"
      log "Открой в браузере: http://${SERVER_IP}:5555"
      log "Ctrl+C чтобы остановить"
      echo ""

      kubectl port-forward pod/prisma-studio 5555:5555 -n "$NAMESPACE" --address 0.0.0.0 || true

      log "Остановка Prisma Studio..."
      kubectl delete pod prisma-studio -n "$NAMESPACE" --ignore-not-found
      ok "Prisma Studio остановлен"
      ;;

    # ─── SQL-консоль ──────────────────────
    --db)
      log "Подключение к PostgreSQL..."
      kubectl exec -it postgresql-0 -n "$NAMESPACE" -- psql -U starsbot -d starsbot
      ;;

    # ─── Масштабирование ──────────────────
    --scale)
      local count="${2:-}"
      if [ -z "$count" ]; then
        local current
        current=$(kubectl get deployment stars-bot -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "?")
        local ready
        ready=$(kubectl get deployment stars-bot -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
        log "Текущие реплики: ${ready}/${current}"
        echo ""
        echo "Использование: ./scripts/deploy.sh --scale <число>"
        echo "Примеры:"
        echo "  ./scripts/deploy.sh --scale 1    # одна реплика (для дебага)"
        echo "  ./scripts/deploy.sh --scale 2    # две реплики (стандарт)"
        echo "  ./scripts/deploy.sh --scale 3    # три реплики (высокая нагрузка)"
        exit 0
      fi
      log "Масштабирование до ${count} реплик..."
      kubectl scale deployment stars-bot -n "$NAMESPACE" --replicas="$count"
      kubectl rollout status deployment stars-bot -n "$NAMESPACE" --timeout=120s
      ok "Запущено ${count} реплик"
      kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=stars-bot -o wide
      ;;

    # ─── Статус ─────────────────────────────
    --status)
      show_status
      ;;

    # ─── Удалить всё ───────────────────────
    --destroy)
      destroy
      ;;

    # ─── Помощь ─────────────────────────────
    --help|-h)
      echo "Использование: ./scripts/deploy.sh [команда]"
      echo ""
      echo "Деплой:"
      echo "  (без аргументов)   Полный деплой (первый раз на сервере)"
      echo "  --update           Обновить код (git pull + build + restart)"
      echo "  --hotfix           Быстрый деплой с кешем Docker (~30с вместо ~2мин)"
      echo "  --update-db        Обновить код + prisma db push (если менялась схема)"
      echo "  --restart          Перезапустить бота без пересборки"
      echo "  --update-secrets   Обновить секреты из .env и перезапустить"
      echo ""
      echo "Мониторинг:"
      echo "  --status           Статус всех компонентов"
      echo "  --logs             Логи бота (follow)"
      echo "  --scale [N]        Показать/изменить количество реплик"
      echo ""
      echo "Инструменты:"
      echo "  --studio           Открыть Prisma Studio (веб-интерфейс к БД)"
      echo "  --merge-legacy F   Слить дамп в текущую БД (или MERGE_LEGACY_USE_EXISTING_IMPORT=1 без F)"
      echo "  --db               SQL-консоль PostgreSQL"
      echo ""
      echo "Опасно:"
      echo "  --destroy          Удалить всё (данные потеряются!)"
      ;;

    *)
      err "Неизвестная команда: $1"
      err "Используй --help для списка команд"
      exit 1
      ;;
  esac
}

main "$@"
