# CoreGit Apply Model — Концепция

## Что это

Маленькая специализированная модель (3-4B параметров), которая делает одну вещь: принимает исходный файл + сокращённый snippet от LLM и возвращает полный merged файл.

## Зачем

Когда coding agent генерирует изменения, он выдаёт не полный файл, а сокращённый фрагмент:

```typescript
function handleAuth(req) {
  // ... existing validation ...
  
  // NEW
  const token = verifyJWT(req.headers.authorization);
  if (!token) throw new UnauthorizedError();
  
  // ... rest of handler ...
}
```

Применить это к файлу на 500 строк — нетривиально. Search-and-replace ломается, diff/patch требует exact line numbers, переписывать весь файл через LLM — медленно и дорого.

Apply model решает это за один вызов на скорости 5-15k tok/s.

## Архитектура

```
Input:  <original>{полный файл}</original>
        <edit>{snippet с маркерами}</edit>
Output: {полный merged файл}
```

Базовая модель: Qwen3-4B или Llama-3.2-3B
Fine-tune: LoRA (не full fine-tune)
Inference: vLLM / TGI
Скорость: 5-15k tok/s на одном A100/H100

## Датасет

### Источник

Open-source repos из GitHub (The Stack v2, GitHub Archive). Нужны репозитории с чистой git историей на популярных языках (TypeScript, Python, Go, Rust, Java).

### Генерация пар

Для каждого коммита, который меняет один файл:

1. `original` = файл ДО коммита (`git show HEAD~1:path`)
2. `merged` = файл ПОСЛЕ коммита (`git show HEAD:path`)
3. `snippet` = сокращённая версия изменений

### Генерация snippets

Это ключевой шаг. Snippet должен выглядеть как output реального LLM — с маркерами пропуска:

**Вариант A (программный):** Берём unified diff, оставляем изменённые строки + 2-3 строки контекста, остальное заменяем на `// ... existing code ...`

**Вариант B (через LLM):** Даём Claude/GPT оригинал + merged и просим "напиши сокращённый snippet как если бы ты был coding agent". Дороже но реалистичнее.

**Вариант C (гибрид):** 70% программно, 30% через LLM для разнообразия стилей.

### Разнообразие маркеров

Модель должна понимать разные стили пропуска:
- `// ... existing code ...`
- `// ... rest of function ...`
- `# keep existing implementation`
- `/* unchanged */`
- `// [previous code remains]`
- Просто `...`

### Объём

50-100k пар — достаточно для LoRA fine-tune. Распределение по языкам: 30% TypeScript/JS, 20% Python, 15% Go, 15% Rust, 10% Java, 10% другие.

### Фильтрация

- Только файлы 10-2000 строк (маленькие неинтересны, огромные — edge case)
- Только коммиты с 1-3 изменёнными файлами (чистые, атомарные изменения)
- Пропускать: generated code, minified, lock files, migrations

## Fine-tune

- Метод: LoRA (rank 16-32), не full fine-tune
- Hardware: 1-2x A100 80GB (или эквивалент в облаке)
- Время: 3-6 часов
- Loss: standard causal LM loss на merged output
- Eval: exact match rate на held-out test set (должно быть >90%)

## Inference / Deployment

- Runtime: vLLM с continuous batching
- Hardware: 1x A100 или 1x H100 (модель маленькая, помещается целиком)
- Endpoint: стандартный OpenAI-compatible `/v1/completions`
- Скорость: 5-15k tok/s (зависит от batch size и hardware)
- Hosting: Modal, RunPod, или свой GPU сервер

## Интеграция с CoreGit API

```
POST /v1/repos/:slug/apply
```

1. Читаем текущий файл из R2
2. Отправляем (original + snippet) в apply model
3. Получаем merged файл
4. Если `commit: true` — создаём коммит через existing commit flow
5. Возвращаем merged code + diff + commit SHA

## Метрики качества

- **Exact match rate**: merged output === expected output (побайтно)
- **Syntax validity**: merged output парсится без ошибок
- **Semantic correctness**: изменения из snippet присутствуют, остальной код не повреждён

## Риски

- **Длинные файлы (>2000 строк)**: context window 4B модели ограничен. Решение: chunking с overlap или fallback на Claude.
- **Множественные edit regions**: snippet меняет 5+ мест в файле. Решение: больше таких примеров в датасете.
- **Неоднозначные маркеры**: `// ...` может быть частью реального кода. Решение: обучать на контексте, не только на маркерах.

## Ориентировочный timeline

| Этап | Время |
|------|-------|
| Скрипт сбора данных из GitHub | 1-2 дня |
| Генерация snippets | 1-2 дня |
| Очистка и фильтрация датасета | 1 день |
| Fine-tune (эксперименты + финальный) | 1-2 дня |
| Inference setup (vLLM + endpoint) | 1 день |
| Интеграция с CoreGit API | 1 день |
| **Итого** | **~7-10 дней** |
