import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import router from './app/router';
import './design/tokens.css';
import './design/base.css';

createApp(App).use(createPinia()).use(router).mount('#app');