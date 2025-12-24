# Supabase Migration Plan

このドキュメントは、将来的にSupabaseへ統合する際の計画をまとめたものです。

## 現在のアーキテクチャ

### データ管理
- ローカルストレージ: 従業員データの一時保存
- Vercel Edge Functions: `/api/state.js` でリモートステート管理
- ICSプロキシ: `/api/ics.js` でGoogle Calendar APIのプロキシ

### 課題
1. Google Calendar ICS URLが変更される可能性
2. APIレート制限の管理が困難
3. データの永続化と同期が不安定
4. スケーラビリティの限界

## Supabase統合の利点

### 1. データベース
- PostgreSQLによる堅牢なデータ管理
- リアルタイム同期機能
- トランザクション対応

### 2. 認証
- ユーザー管理の一元化
- Row Level Security (RLS)
- OAuth統合

### 3. ストレージ
- ICSファイルのキャッシュ
- ログファイルの保存

### 4. Edge Functions
- Denoベースのサーバーレス関数
- ICSフェッチロジックの移行

## 移行計画

### Phase 1: データベーススキーマ設計
```sql
-- 従業員テーブル
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  calendar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- カレンダーキャッシュテーブル
CREATE TABLE calendar_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  calendar_url TEXT NOT NULL,
  ics_data TEXT NOT NULL,
  cached_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(calendar_url)
);

-- イベントログテーブル（監査用）
CREATE TABLE event_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- 'check_in', 'check_out', etc.
  event_time TIMESTAMPTZ NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_calendar_cache_url ON calendar_cache(calendar_url);
CREATE INDEX idx_calendar_cache_expires ON calendar_cache(expires_at);
CREATE INDEX idx_event_logs_employee_time ON event_logs(employee_id, event_time DESC);
```

### Phase 2: Edge Functions実装

#### 1. ICSフェッチ関数 (`supabase/functions/fetch-ics/index.ts`)
```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const { url } = await req.json()
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // キャッシュをチェック
  const { data: cached } = await supabase
    .from('calendar_cache')
    .select('ics_data, expires_at')
    .eq('calendar_url', url)
    .single()

  if (cached && new Date(cached.expires_at) > new Date()) {
    return new Response(JSON.stringify({ data: cached.ics_data, cached: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // フェッチしてキャッシュに保存
  const response = await fetch(url, {
    headers: { 'User-Agent': 'attendance-dashboard/supabase' },
  })
  const icsData = await response.text()

  await supabase
    .from('calendar_cache')
    .upsert({
      calendar_url: url,
      ics_data: icsData,
      cached_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5分
    })

  return new Response(JSON.stringify({ data: icsData, cached: false }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

#### 2. 従業員同期関数 (`supabase/functions/sync-employees/index.ts`)
```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .order('name')
    
    return new Response(JSON.stringify({ data, error }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (req.method === 'POST') {
    const employees = await req.json()
    const { data, error } = await supabase
      .from('employees')
      .upsert(employees, { onConflict: 'id' })
    
    return new Response(JSON.stringify({ data, error }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response('Method not allowed', { status: 405 })
})
```

### Phase 3: フロントエンド改修

現在のコードはすでにキャッシング機能を実装しているため、Supabase APIへの切り替えは比較的容易です：

```typescript
// 現在の実装を維持しつつ、バックエンドをSupabaseに切り替え
const fetchIcsText = useCallback(async (url: string) => {
  const response = await fetch('/api/supabase/fetch-ics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const { data, cached } = await response.json()
  if (cached) console.log('Using Supabase cached ICS')
  return data
}, [])
```

### Phase 4: 移行手順

1. **並行運用**: Supabaseを導入しながら現在のシステムを維持
2. **段階的移行**: 一部の機能からSupabaseに移行
3. **検証**: 両システムでデータ整合性を確認
4. **完全移行**: 旧システムを削除

## 現在の改善で将来の移行を容易にする設計

### 実装済み
- ? キャッシング機能（`cacheRef`）- Supabaseのキャッシュテーブルに置き換え可能
- ? エラーハンドリングとリトライロジック
- ? 並列処理（`Promise.allSettled`）
- ? タイムアウト設定

### 今後の改善
- [ ] 環境変数による設定管理（`.env.local`）
- [ ] APIエンドポイントの抽象化レイヤー
- [ ] データモデルの型定義強化
- [ ] テストスイートの整備

## 環境変数の準備

```env
# .env.local (開発環境)
VITE_SUPABASE_URL=your-project-url.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# Supabase側 (Edge Functions)
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## 参考リンク

- [Supabase Documentation](https://supabase.com/docs)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Database](https://supabase.com/docs/guides/database)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
