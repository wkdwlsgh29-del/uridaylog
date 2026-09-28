// `node --test baby-log/tests/` 진입점 — Node 22 는 디렉터리 인자를 모듈 경로로 읽어서 이 파일을 실행한다.
// 이 폴더의 테스트를 모두 불러와 한 프로세스에서 차례로 돌린다. (직접: node --test 'baby-log/tests/*.test.mjs')
import('./logic.test.mjs');
import('./store-sync.test.mjs');
