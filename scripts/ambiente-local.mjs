/**
 * Prepara o ambiente local inteiro (banco + backend + front) num comando só.
 *
 *   npm run local         # prepara o que faltar e sobe front + back
 *   npm run local:seed    # refaz o seed e as contas de teste (sem subir nada)
 *
 * Existe porque, partindo de um clone limpo, chegar numa arena de batalha na
 * tela exigia uns dez passos espalhados por três READMEs: instalar as
 * dependências de três pastas, montar o `.env` do backend, subir o Postgres,
 * aplicar as migrations, rodar o seed e — o passo que ninguém lembra —
 * criar uma conta COM capturas. Sem captura não há time, e sem time não se
 * chega na arena; quem só queria mexer num efeito visual da batalha ficava
 * preso no scanner de QR.
 *
 * O que ele faz, nesta ordem, pulando o que já estiver pronto:
 *  1. `npm ci` na raiz, no profdex-back e no profdex-front (só onde não há
 *     `node_modules`);
 *  2. cria `profdex-back/.env` a partir do `.env.example`, já apontando para o
 *     Postgres local do Docker (porta 55432) e com um JWT_SECRET aleatório.
 *     Um `.env` que já existe nunca é reescrito;
 *  3. sobe o Postgres com `npm run db:up`, se ele ainda não estiver aceitando
 *     conexões. Quem tem um Postgres nativo é só apontar o `.env` para ele;
 *  4. `prisma migrate deploy`;
 *  5. na primeira vez (ou com `--seed`): seed completo e as contas de teste.
 *
 * ⚠️ Recusa qualquer DATABASE_URL que não seja local. Este script cria contas
 * de teste e dá a dex inteira ao admin — contra o banco do evento, isso
 * poluiria o ranking e a Profdex de quem organiza.
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BACK = path.join(RAIZ, 'profdex-back')
const FRONT = path.join(RAIZ, 'profdex-front')
const ENV_BACK = path.join(BACK, '.env')

// Mesma string do bloco "Postgres local via Docker" do .env.example e da porta
// publicada no profdex-back/docker-compose.yml.
const URL_LOCAL = 'postgresql://profdex:profdex@localhost:55432/profdex'
const HOSTS_LOCAIS = ['localhost', '127.0.0.1', '::1', 'host.docker.internal']

// Contas que o seed de teste cria. Se todas existem, o banco já foi semeado.
const CONTAS_DE_TESTE = ['ana', 'bia', 'dex']

const forcarSeed = process.argv.includes('--seed')

function passo(texto) {
  console.log(`\n▸ ${texto}`)
}

function falhar(texto) {
  console.error(`\n❌ ${texto}`)
  process.exit(1)
}

/**
 * `shell: true` porque no Windows o `npm` é `npm.cmd`, que o spawn sem shell
 * não encontra. As variáveis vão por `env`, e não como `VAR=x npm …`, que é
 * sintaxe de bash e não funciona no cmd/PowerShell.
 */
function rodar(comando, { cwd = RAIZ, env = {} } = {}) {
  const r = spawnSync(comando, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...env },
  })
  if (r.status !== 0) {
    falhar(`"${comando}" falhou (em ${path.relative(RAIZ, cwd) || '.'}).`)
  }
}

function conferirNode() {
  const [maior, menor] = process.versions.node.split('.').map(Number)
  // O mesmo `engines` do profdex-front/package.json (exigência do Vite 8).
  const ok = (maior === 20 && menor >= 19) || (maior === 22 && menor >= 12) || maior > 22
  if (!ok) {
    falhar(`Node ${process.versions.node} é antigo demais: o front pede ^20.19 ou >=22.12.`)
  }
}

function instalarDependencias() {
  for (const dir of [RAIZ, BACK, FRONT]) {
    if (existsSync(path.join(dir, 'node_modules'))) continue
    passo(`Instalando dependências em ${path.relative(RAIZ, dir) || 'raiz'}`)
    rodar('npm ci', { cwd: dir })
  }
}

/** Troca a linha `CHAVE=…` não comentada pelo valor dado. */
function definir(texto, chave, valor) {
  const linha = new RegExp(`^${chave}=.*$`, 'm')
  return texto.replace(linha, `${chave}="${valor}"`)
}

function criarEnvDoBackend() {
  if (existsSync(ENV_BACK)) return
  passo('Criando profdex-back/.env para o banco local')
  let texto = readFileSync(path.join(BACK, '.env.example'), 'utf8')
  texto = definir(texto, 'DATABASE_URL', URL_LOCAL)
  texto = definir(texto, 'DIRECT_URL', URL_LOCAL)
  texto = definir(texto, 'JWT_SECRET', randomBytes(32).toString('hex'))
  writeFileSync(ENV_BACK, texto)
}

function lerDatabaseUrl() {
  const linha = readFileSync(ENV_BACK, 'utf8').match(/^DATABASE_URL=["']?([^"'\r\n]+)/m)
  if (!linha) falhar('profdex-back/.env não tem DATABASE_URL.')
  try {
    return new URL(linha[1])
  } catch {
    falhar('A DATABASE_URL do profdex-back/.env não é uma URL válida.')
  }
}

function aceitaConexao(host, porta) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: porta })
    const fim = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1500, () => fim(false))
    socket.once('connect', () => fim(true))
    socket.once('error', () => fim(false))
  })
}

async function garantirBanco(url) {
  const host = url.hostname
  const porta = Number(url.port || 5432)

  if (!HOSTS_LOCAIS.includes(host)) {
    falhar(
      `O profdex-back/.env aponta para "${host}", que não é um banco local.\n` +
        '   Este script cria contas de teste e capturas — não pode rodar contra o\n' +
        `   banco do evento. Para o ambiente local, use:\n     DATABASE_URL="${URL_LOCAL}"`,
    )
  }

  if (await aceitaConexao(host, porta)) return

  passo(`Nada escutando em ${host}:${porta} — subindo o Postgres do Docker`)
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore', shell: true })
  if (docker.status !== 0) {
    falhar(
      'O Docker não respondeu. Abra o Docker Desktop e rode de novo — ou, se você\n' +
        '   tem um Postgres instalado, crie o usuário/banco "profdex" e aponte a\n' +
        '   DATABASE_URL e a DIRECT_URL do profdex-back/.env para ele.',
    )
  }
  rodar('npm run db:up', { cwd: BACK })

  if (!(await aceitaConexao(host, porta))) {
    falhar(
      `O container subiu, mas ${host}:${porta} continua fechado. O compose publica\n` +
        `   a porta 55432; confira se a DATABASE_URL usa essa porta.`,
    )
  }
}

/** Quantas das contas de teste já existem. -1 quando a consulta falhou. */
function contasDeTesteExistentes() {
  const codigo = `
    require('./scripts/db-url').requireDatabaseUrl()
    const { PrismaClient } = require('@prisma/client')
    const db = new PrismaClient()
    db.user
      .count({ where: { matricula: { in: ${JSON.stringify(CONTAS_DE_TESTE)} } } })
      .then((n) => console.log(n))
      .catch(() => console.log(-1))
      .finally(() => db.$disconnect())
  `
  const r = spawnSync(process.execPath, ['-e', codigo], { cwd: BACK, encoding: 'utf8' })
  const n = Number.parseInt((r.stdout || '').trim().split('\n').pop(), 10)
  return Number.isNaN(n) ? -1 : n
}

function semear() {
  passo('Seed: professores, quiz e a conta admin')
  rodar('npm run db:seed', { cwd: BACK })

  passo('Contas de teste: ana e bia (3 exemplares cada), dex (dex completa)')
  rodar('npm run db:seed-treinadores', { cwd: BACK })
  rodar('npm run db:seed-dex-completa', { cwd: BACK })

  // `todos` pula quem a conta já tem, então rodar de novo não duplica nada.
  passo('Dando a coleção inteira à conta admin')
  rodar('npm run db:dar-capturas', { cwd: BACK, env: { MATRICULA: 'admin', SLUGS: 'todos' } })
}

async function main() {
  conferirNode()
  instalarDependencias()
  criarEnvDoBackend()
  await garantirBanco(lerDatabaseUrl())

  passo('Aplicando as migrations')
  rodar('npx prisma migrate deploy', { cwd: BACK })

  if (forcarSeed || contasDeTesteExistentes() < CONTAS_DE_TESTE.length) {
    semear()
  } else {
    console.log('\n✓ Banco já semeado (use `npm run local:seed` para refazer).')
  }

  console.log(`
✅ Ambiente local pronto.

   App:   http://localhost:5173
   API:   http://localhost:3000/api

   Contas (matrícula / senha):
     admin / 123456     — painel /admin e a coleção inteira
     ana   / senha123   — 3 exemplares do Eron (time de 3 no treino)
     bia   / senha123   — Gustavo, Mário e Eron
     dex   / senha123   — dex completa (gate da raid)

   Para chegar na arena: Batalha → Treino → 3 CONTRA 3.
   Celular na mesma rede: HTTPS=1 em profdex-front/.env.local (a câmera pede HTTPS).`)
}

main().catch((e) => falhar(e.message))
