/**
 * Small bundled list of very common passwords / bases. A candidate is refused when its lowercase form, or that form
 * with trailing digits and punctuation removed, is one of these. This is a speed bump, not a breach corpus.
 */
const COMMON = `
password passwort passw0rd p@ssw0rd p@ssword pa55word pa55w0rd letmein letmein123 welcome welcome1 admin administrator root toor
qwerty qwertyuiop qwertyuiopasdf asdfghjkl asdfghjklzxcv zxcvbnm zxcvbnm123 1qaz2wsx 1q2w3e4r 1q2w3e4r5t 1qazxsw2 qazwsxedc
iloveyou iloveyou2 monkey dragon master sunshine princess football baseball basketball soccer hockey shadow superman batman
trustno1 trustnoone abc123 abcdefg abcdefgh abcdefghijkl abcd1234 changeme change-me default secret secretpassword mypassword
mypass myspace login loginlogin starwars whatever freedom computer internet michael jennifer jordan hunter ranger buster thomas
charlie summer winter spring autumn flower cheese banana hello hello123 helloworld hellohello test testing testtest test1234
guest user username access cookie killer pepper ginger cheese123 samsung google facebook twitter youtube mnemonis memory
passwordpassword passwordpass password1password
correcthorsebatterystaple thequickbrownfox iloveyoutoo iloveyou123 loveyou123 ilovemyself ilovemyfamily mypassword123 myverysecretpassword
yourpassword newpassword123 newpassword temp1234 temporary temppassword temppassword123 welcome123 welcome2023 welcome2024 welcome2025
letmeinletmein letmein1234 openseasame opensesame sesame abcabcabc qwerty123 qwerty1234 qwertyuiop123 qwertyuiopqwerty asdfasdfasdf
asdf1234 asdfghjkl123 zaq12wsx zaq1zaq1 1qaz2wsx3edc 1q2w3e4r5t6y 123qweasdzxc qazwsx123 qweasdzxc mnbvcxz poiuytrewq lkjhgfdsa
football123 baseball1 basketball1 superman1 batman123 pokemon pokemon123 minecraft fortnite starwars1 starwars123 harrypotter hogwarts
liverpool manchester arsenal chelsea barcelona realmadrid yankees cowboys lakers america philippines manila singapore
trustno1trustno1 passw0rdpassw0rd p@ssw0rd123 p@ssword123 password123 password1234 password12345 password123456 pass1234pass1234
administrator1 administrator123 adminadmin adminadmin123 rootroot rootroot123 superuser sysadmin
iamthebest iloveyoumom monkey123 dragon123 shadow123 master123 sunshine1 princess1 butterfly butterfly1 corvette mustang
`
  .split(/\s+/)
  .filter(Boolean);

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(COMMON);

const strip = (s: string): string => s.replace(/[\d!@#$%^&*._-]+$/u, "");

export function isCommonPassword(password: string): boolean {
  const p = password.toLowerCase();
  if (COMMON_PASSWORDS.has(p) || COMMON_PASSWORDS.has(strip(p))) return true;
  const chars = [...p];
  if (new Set(chars).size === 1) return true; // aaaaaaaaaaaa
  if ("01234567890123456789".includes(p) || "abcdefghijklmnopqrstuvwxyz".includes(p) || "qwertyuiopasdfghjklzxcvbnm".includes(p)) return true; // keyboard / digit runs
  return false;
}
