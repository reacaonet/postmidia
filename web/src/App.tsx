import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { health } from './api';
import { bindUnauthorizedHandler, useSession } from './session';
import LoginPage from './pages/LoginPage';
import AccountsPage from './pages/AccountsPage';
import CampaignsPage from './pages/CampaignsPage';
import TemplatesPage from './pages/TemplatesPage';
import DeadLettersPage from './pages/DeadLettersPage';
import AuditPage from './pages/AuditPage';
import OpsPage from './pages/OpsPage';

export default function App(): JSX.Element {
  const { token, user, tenant, logout, expire } = useSession();

  // Um 401 em qualquer tela encerra a sessao uma unica vez, aqui, em vez de cada
  // tela tratar o proprio erro. `bindUnauthorizedHandler` existe justamente para
  // nao criar ciclo de import entre o provider e as telas. Usa `expire` e nao
  // `logout` para que a tela de login saiba explicar que o token venceu.
  useEffect(() => {
    bindUnauthorizedHandler(expire);
    return () => bindUnauthorizedHandler(null);
  }, [expire]);

  if (!token) {
    return (
      <Routes>
        <Route path="/entrar" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/entrar" replace />} />
      </Routes>
    );
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">postmidia</div>
        <NavLink to="/contas" className={navClass}>
          Contas
        </NavLink>
        <NavLink to="/campanhas" className={navClass}>
          Campanhas
        </NavLink>
        <NavLink to="/templates" className={navClass}>
          Templates
        </NavLink>

        <div className="nav-group">Operação</div>
        <NavLink to="/fila-morta" className={navClass}>
          Fila morta
        </NavLink>
        <NavLink to="/auditoria" className={navClass}>
          Auditoria
        </NavLink>
        <NavLink to="/operacao" className={navClass}>
          Painel operacional
        </NavLink>

        <div style={{ marginTop: 'auto', paddingTop: 16 }}>
          <div className="hint" style={{ padding: '0 10px' }}>
            {tenant?.slug ?? '—'}
            {user && (
              <>
                <br />
                {user.email} · {user.role}
              </>
            )}
          </div>
          <button className="secondary small" style={{ marginTop: 8, width: '100%' }} onClick={logout}>
            Sair
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <span style={{ fontWeight: 600 }}>{tenant?.name ?? 'postmidia'}</span>
          <BackendStatus />
        </header>
        <main className="content">
          <Routes>
            <Route path="/contas" element={<AccountsPage />} />
            <Route path="/campanhas" element={<CampaignsPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/fila-morta" element={<DeadLettersPage />} />
            <Route path="/auditoria" element={<AuditPage />} />
            <Route path="/operacao" element={<OpsPage />} />
            <Route path="*" element={<Navigate to="/contas" replace />} />
          </Routes>
        </main>
      </div>

    </div>
  );
}

const navClass = ({ isActive }: { isActive: boolean }): string =>
  `nav-link${isActive ? ' active' : ''}`;

/**
 * Estado da API no topo.
 *
 * `GET /health` e a unica resposta sem envelope e nao exige token, entao serve
 * para distinguir "backend caiu" de "backend recusou meu token" — distincao que
 * a tela sozinha nao faz. Falhar aqui e aparecer "offline" e util mesmo sem
 * token, mas so interessa depois do login, entao a checagem espera o token.
 */
const BackendStatus = (): JSX.Element => {
  const { token } = useSession();
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking');

  useEffect(() => {
    if (!token) return;
    let alive = true;
    setState('checking');
    health()
      .then((result) => {
        if (alive) setState(result.status === 'ok' ? 'up' : 'down');
      })
      .catch(() => {
        if (alive) setState('down');
      });
    return () => {
      alive = false;
    };
  }, [token]);

  if (state === 'up') {
    return <span className="pill ok">API no ar</span>;
  }
  if (state === 'down') {
    return (
      <span className="pill err" title="A API não respondeu em /health. O Vite está no ar; o backend não está.">
        API fora do ar
      </span>
    );
  }
  return <span className="pill neutral">verificando API…</span>;
};
