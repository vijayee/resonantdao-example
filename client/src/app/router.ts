import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'feed', component: () => import('../components/feed/FeedPage.vue') },
    { path: '/proposals', name: 'proposals', component: () => import('../components/proposals/ProposalsPage.vue') },
    { path: '/elections', name: 'elections', component: () => import('../components/elections/ElectionsPage.vue') },
    { path: '/contribute', name: 'contribute', component: () => import('../components/contribute/ContributePage.vue') },
    { path: '/round', name: 'round', component: () => import('../components/round/RoundPage.vue') },
    { path: '/custodians', name: 'custodians', component: () => import('../components/custodians/CustodiansPage.vue') },
    { path: '/account', name: 'account', component: () => import('../components/account/AccountPlaceholder.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!auth.authed && to.name !== 'feed') return { name: 'feed' };
  return true;
});

export default router;
