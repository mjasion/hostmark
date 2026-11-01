import { createRoot } from 'react-dom/client';
import { App, createAppQueryClient, createAppRouter } from './router';
import './styles.css';

const queryClient = createAppQueryClient(() => void router.navigate({ to: '/login' }));
const router = createAppRouter(queryClient);

const root = document.getElementById('root');
if (root) createRoot(root).render(<App queryClient={queryClient} router={router} />);
